/**
 * xAI Grok OAuth 2.0 + PKCE implementation.
 *
 * Uses Web Crypto API (crypto.subtle) for PKCE so the extension is
 * portable across Node versions and potential non-Node runtimes.
 *
 * Based on the Hermes agent xai-oauth flow, adapted for the pi SDK.
 */

import { createServer } from "node:http";
import { XaiErrorCode, XaiOAuthError, classifyHttpStatus } from "./errors.js";
import { safeFetch, readBoundedText, readBoundedJson } from "./safe-fetch.js";
import { parseBoundedJson } from "./bounded-json.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const ISSUER = "https://auth.x.ai";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const DEVICE_CODE_URL = `${ISSUER}/oauth2/device/code`;
const DEVICE_TOKEN_URL = `${ISSUER}/oauth2/token`;
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** Client version label sent on the device-code auth requests. */
const CLIENT_VERSION = process.env.PI_XAI_CLIENT_VERSION || "0.2.101";
const CLIENT_ID = process.env.PI_XAI_OAUTH_CLIENT_ID || "b1a00492-073a-47ea-816f-4c329264a828";
// conversations:read/write let the proxy attach session history to
// x-grok-conv-id so multi-turn OAuth chats can resume server-side state.
const SCOPE = process.env.PI_XAI_OAUTH_SCOPE || "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
const CALLBACK_HOST = process.env.PI_XAI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const DEFAULT_CALLBACK_PORT = 56121;
const CALLBACK_PORT = parseCallbackPort(process.env.PI_XAI_OAUTH_CALLBACK_PORT);
const CALLBACK_PATH = "/callback";
/** Refresh 5 min before actual expiry. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
/** Tolerance for id_token exp against issuer clock drift. */
const ID_TOKEN_CLOCK_SKEW_MS = 30_000;
/** Reject any auth-path response body larger than this before parsing.
 * Covers OIDC discovery, token exchange, refresh, device code, JWKS. */
const AUTH_MAX_RESPONSE_BYTES = 64 * 1024;

/** Parse the callback-port override, falling back to the default on anything invalid. */
export function parseCallbackPort(raw: string | undefined): number {
	if (!raw) return DEFAULT_CALLBACK_PORT;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_CALLBACK_PORT;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface XaiDiscovery {
	authorization_endpoint: string;
	token_endpoint: string;
	/** JWKS URI for id_token signature verification (required, validated xAI origin). */
	jwks_uri: string;
	/** Signing algorithm xAI advertises for id_tokens (must be ES256). */
	id_token_signing_alg_values_supported?: string[];
}

export interface XaiOAuthCredentials {
	[key: string]: unknown;
	refresh: string;
	access: string;
	expires: number;
	tokenEndpoint?: string;
	discovery?: XaiDiscovery;
	idToken?: string;
	tokenType?: string;
	baseUrl?: string;
}

/**
 * Discriminated result of the OAuth callback wait. One fact, one representation.
 *
 * Every source (browser callback, manual paste, abort signal, timeout, server
 * error) funnels into one of these variants. `login()` switches on `kind`
 * once; `outcomeToError()` is the single boundary that converts the
 * `cancelled` variant into the `Error("Login cancelled")` sentinel pi's
 * LoginDialog matches on.
 */
type CallbackOutcome =
	| { kind: "ok"; code: string; state: string }
	| { kind: "cancelled" }
	| { kind: "error"; message: string };

/** Sentinel message pi's LoginDialog matches on to suppress the error UI. */
const LOGIN_CANCELLED = "Login cancelled";

/**
 * Convert a non-ok callback outcome into the thrown error pi's dialog expects.
 *
 * `cancelled` becomes `Error(LOGIN_CANCELLED)`, which pi's LoginDialog swallows.
 * `error` becomes a typed `XaiOAuthError`. This is the only site that produces
 * the thrown cancel sentinel, so the `LOGIN_CANCELLED` literal lives nowhere
 * else and the triplication the pre-refactor code had can't regress.
 */
export function outcomeToError(outcome: Extract<CallbackOutcome, { kind: "cancelled" | "error" }>): Error {
	if (outcome.kind === "cancelled") return new Error(LOGIN_CANCELLED);
	return new XaiOAuthError(outcome.message, XaiErrorCode.AUTHORIZATION_FAILED);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getBaseUrl(): string {
	return (
		process.env.PI_XAI_BASE_URL ||
		process.env.XAI_BASE_URL ||
		DEFAULT_BASE_URL
	).replace(/\/+$/, "");
}

function base64Url(buffer: ArrayBuffer | Uint8Array): string {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ─── PKCE ─────────────────────────────────────────────────────────────────────

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(hash) };
}

// ─── Manual-paste parsing ────────────────────────────────────────────────────

/**
 * Parse a pasted redirect URL (or bare code) the user may have dropped into
 * the manual-paste prompt. Accepts the full `http://127.0.0.1:PORT/callback?code=...&state=...`
 * redirect, a `code=...&state=...` querystring, or the raw code.
 */
export function parseRedirectUrl(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL, fall through
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}
	return { code: value };
}

// ─── Endpoint validation ──────────────────────────────────────────────────────

/**
 * True for HTTPS URLs on the xAI origin (x.ai / *.x.ai). Used both to pin OIDC
 * discovery endpoints and to validate id_token issuers.
 */
export function isXaiOrigin(url: URL): boolean {
	const host = url.hostname.toLowerCase();
	return url.protocol === "https:" && (host === "x.ai" || host.endsWith(".x.ai"));
}

/**
 * Refuse any OIDC endpoint that isn't HTTPS on the xAI origin.
 *
 * The cached discovery response is long-lived in auth.json.  A single MITM
 * during initial login could substitute a malicious token_endpoint that would
 * receive every subsequent refresh_token.  Validating scheme + host pins the
 * endpoint to x.ai / *.x.ai so cache poisoning can't persist.
 */
export function validateEndpoint(value: string, field: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new XaiOAuthError(
			`xAI OAuth discovery returned invalid ${field}: ${value}`,
			XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
		);
	}
	if (!isXaiOrigin(url)) {
		throw new XaiOAuthError(
			`Refusing non-xAI OAuth ${field}: ${value}`,
			XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
		);
	}
	return url.toString();
}

// ─── OIDC Discovery ──────────────────────────────────────────────────────────

export async function discover(): Promise<XaiDiscovery> {
	let response: Response;
	try {
		response = await safeFetch(DISCOVERY_URL, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});
	} catch (cause) {
		throw new XaiOAuthError(
			`xAI OIDC discovery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
			XaiErrorCode.DISCOVERY_FAILED,
		);
	}
	if (!response.ok) {
		throw new XaiOAuthError(
			`xAI OIDC discovery returned ${response.status}`,
			XaiErrorCode.DISCOVERY_FAILED,
		);
	}
	let payload: Record<string, unknown>;
	try {
		payload = (await readBoundedJson(response, AUTH_MAX_RESPONSE_BYTES)) as Record<string, unknown>;
	} catch (cause) {
		throw new XaiOAuthError(
			`xAI OIDC discovery returned an unparseable body: ${cause instanceof Error ? cause.message : String(cause)}`,
			XaiErrorCode.DISCOVERY_FAILED,
		);
	}
	const authorizationEndpoint = validateEndpoint(String(payload.authorization_endpoint ?? ""), "authorization_endpoint");
	const tokenEndpoint = validateEndpoint(String(payload.token_endpoint ?? ""), "token_endpoint");

	// Pin the JWKS URI to the xAI origin so a MITM'd discovery response can't
	// point id_token verification at an attacker-controlled key set. jwks_uri
	// is required here: without it, signature verification cannot run, and a
	// stripped discovery document would fail open to claims-only checks.
	const jwksUriRaw = payload.jwks_uri;
	if (typeof jwksUriRaw !== "string" || !jwksUriRaw) {
		throw new XaiOAuthError(
			"xAI OIDC discovery omitted jwks_uri; id_token signature verification requires it.",
			XaiErrorCode.DISCOVERY_FAILED,
		);
	}
	const jwksUri = validateEndpoint(jwksUriRaw, "jwks_uri");

	// xAI's pinned signing algorithm is ES256. If the discovery response
	// advertises a set, refuse anything that does not include ES256 so a
	// weaker alg can't slip in via discovery.
	const algs = Array.isArray(payload.id_token_signing_alg_values_supported)
		? payload.id_token_signing_alg_values_supported.filter((a): a is string => typeof a === "string")
		: undefined;
	if (algs && !algs.includes("ES256")) {
		throw new XaiOAuthError(
			"xAI OIDC discovery does not advertise ES256 for id_token signing.",
			XaiErrorCode.DISCOVERY_FAILED,
		);
	}

	return {
		authorization_endpoint: authorizationEndpoint,
		token_endpoint: tokenEndpoint,
		jwks_uri: jwksUri,
		id_token_signing_alg_values_supported: algs,
	};
}

// ─── Loopback callback server ────────────────────────────────────────────────

/**
 * Resolve as soon as one of {callback, timeout, abort} fires, and clean up the
 * others. Whichever branch wins, the losing timer and listener are torn down,
 * leaving no leaked setTimeout and no dangling abort handler. Returns a
 * CallbackOutcome so the caller has one switch to make.
 */
function raceCallback(
	callbackPromise: Promise<CallbackResult>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<CallbackOutcome> {
	return new Promise((resolve) => {
		let done = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => finish({ kind: "cancelled" });
		const finish = (o: CallbackOutcome) => {
			if (done) return;
			done = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(o);
		};

		// Already-aborted signal: settle immediately, before wiring anything.
		if (signal?.aborted) {
			finish({ kind: "cancelled" });
			return;
		}

		timer = setTimeout(
			() => finish({ kind: "error", message: "Timed out waiting for xAI OAuth callback." }),
			timeoutMs,
		);

		if (signal) signal.addEventListener("abort", onAbort, { once: true });

		callbackPromise.then(
			(r) => finish(
				r.error
					? { kind: "error", message: r.errorDescription ?? r.error ?? "xAI authorization failed." }
					: { kind: "ok", code: r.code ?? "", state: r.state ?? "" },
			),
			(err) => finish({
				kind: "error",
				message: err instanceof Error ? err.message : String(err),
			}),
		);
	});
}

interface CallbackResult {
	code?: string;
	state?: string;
	error?: string;
	errorDescription?: string;
}

function startCallbackServer(): Promise<{
	server: import("node:http").Server;
	redirectUri: string;
	waitForCallback: (timeoutMs: number, signal?: AbortSignal) => Promise<CallbackOutcome>;
}> {
	let settle: ((value: CallbackResult) => void) | undefined;
	let served = false; // first terminal redirect wins; later ones are acknowledged and dropped
	const callbackPromise = new Promise<CallbackResult>((resolve) => { settle = resolve; });

	const server = createServer((req, res) => {
		try {
			// CORS preflight for accounts.x.ai redirect
			const origin = req.headers.origin;
			if (origin === "https://accounts.x.ai" || origin === "https://auth.x.ai") {
				res.setHeader("Access-Control-Allow-Origin", origin);
				res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
				res.setHeader("Access-Control-Allow-Headers", "Content-Type");
				res.setHeader("Access-Control-Allow-Private-Network", "true");
				res.setHeader("Vary", "Origin");
			}
			if (req.method === "OPTIONS") {
				res.statusCode = 204;
				res.end();
				return;
			}

			const url = new URL(req.url ?? "/", `http://${CALLBACK_HOST}`);
			if (url.pathname !== CALLBACK_PATH) {
				res.statusCode = 404;
				res.end("Not found");
				return;
			}

			const result: CallbackResult = {
				code: url.searchParams.get("code") ?? undefined,
				state: url.searchParams.get("state") ?? undefined,
				error: url.searchParams.get("error") ?? undefined,
				errorDescription: url.searchParams.get("error_description") ?? undefined,
			};

			if (served) {
				// Duplicate redirect (browser back-button, stale tab). We already
				// have an outcome; acknowledge and drop it so it can't double-settle.
				res.statusCode = 200;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end("<html><body><h1>xAI login already handled.</h1>You can close this tab.</body></html>");
				return;
			}
			served = true;

			res.statusCode = result.error ? 400 : 200;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			const html = result.error
				? "<html><body><h1>xAI authorization failed.</h1>You can close this tab.</body></html>"
				: "<html><body><h1>xAI authorization received.</h1>You can close this tab.</body></html>";
			res.end(html);
			settle?.(result);
		} catch {
			res.statusCode = 500;
			res.end("Internal error");
		}
	});

	const listen = (port: number) => new Promise<number>((resolve, reject) => {
		const onError = (err: NodeJS.ErrnoException) => reject(err);
		server.once("error", onError);
		server.listen(port, CALLBACK_HOST, () => {
			server.removeListener("error", onError);
			const addr = server.address();
			resolve(typeof addr === "object" && addr ? addr.port : port);
		});
	});

	return (async () => {
		let actualPort: number;
		try {
			actualPort = await listen(CALLBACK_PORT);
		} catch {
			actualPort = await listen(0); // OS-assigned port
		}
		// Keep a permanent error listener so a late server error (port clash
		// from a second login, socket exhaustion, etc.) doesn't crash the
		// process via an unhandled `error` event. Resolve the callback promise
		// so any pending `waitForCallback` unblocks instead of hanging.
		server.on("error", (err) => {
			settle?.({
				error: "server_error",
				errorDescription: err instanceof Error ? err.message : String(err),
			});
		});
		// The listener must not keep the event loop alive on its own (pi
		// drives the loop during login), and half-open connections should be
		// dropped fast rather than wedging the socket.
		server.unref();
		server.requestTimeout = 10_000;
		server.headersTimeout = 12_000;
		const redirectUri = `http://${CALLBACK_HOST}:${actualPort}${CALLBACK_PATH}`;
		return {
			server,
			redirectUri,
			waitForCallback: (timeoutMs: number, signal?: AbortSignal) =>
				raceCallback(callbackPromise, timeoutMs, signal),
		};
	})();
}

// ─── JWT / id_token validation ──────────────────────────────────────────────

interface IdTokenClaims {
	iss?: string;
	aud?: string | string[];
	sub?: string;
	nonce?: string;
	exp?: number;
}

/** Decode a JWT's payload object without verifying its signature. Returns
 * null for a non-JWT or unparseable token. Shared by id_token parsing and
 * access-token exp extraction so the base64url JSON decode lives in one place. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		// JWT payload is base64url without padding.
		const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
		const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
		return JSON.parse(atob(padded)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function decodeIdToken(token: string): IdTokenClaims | null {
	return decodeJwtPayload(token) as IdTokenClaims | null;
}

// ─── Access-token expiry (JWT exp) ────────────────────────────────────────────

/** Decode the `exp` claim (seconds since epoch) from an access-token JWT.
 * Returns null for a non-JWT or unparseable token, or one with no numeric exp.
 * Used to derive the real expiry independent of the stored timestamp, which
 * can drift on clock skew or when another process rotated the token. */
export function decodeJwtExp(token: string): number | null {
	const claims = decodeJwtPayload(token);
	if (!claims) return null;
	return typeof claims.exp === "number" ? claims.exp : null;
}


/** Compute the stored expiry timestamp, capped by the access token's real JWT
 * `exp` when present, so the host refreshes no later than the token actually
 * expires. Falls back to the expires_in-based value for opaque tokens. */
function computeExpires(accessToken: string, expiresInSec: number): number {
	const fromExpiresIn = Date.now() + expiresInSec * 1000 - REFRESH_SKEW_MS;
	const exp = decodeJwtExp(accessToken);
	if (exp === null) return fromExpiresIn;
	return Math.min(fromExpiresIn, exp * 1000 - REFRESH_SKEW_MS);
}

/**
 * Validate the id_token claims returned in the token exchange.
 *
 * - `iss` must be the xAI issuer (or a sub-path of it).
 * - `aud` must contain our client_id.
 * - `nonce`, if present, must match the one sent in the authorize request.
 *   Only enforced when `expectedNonce` is non-empty: device and refresh
 *   callers pass `""` because they never established a nonce with the AS,
 *   and a claim that happens to be present on those tokens is not bound to
 *   anything we know. PKCE plus the one-time code (browser) or the
 *   device_code grant still bind the exchange.
 * - `exp`, if present, must be in the future (30s clock skew allowed).
 *
 * Returns on success; throws `ID_TOKEN_INVALID` on any mismatch.
 * If no id_token is present, this is a no-op (the provider may legitimately
 * omit it).
 *
 * Claims only. Signature verification lives in `verifyIdTokenSignature`,
 * which `discover()` always provisions a JWKS URI for.
 */
export function validateIdToken(idToken: string, expectedNonce: string): void {
	const claims = decodeIdToken(idToken);
	if (!claims) {
		throw new XaiOAuthError(
			"xAI token exchange returned an unparseable id_token.",
			XaiErrorCode.ID_TOKEN_INVALID,
		);
	}

	// Issuer must be HTTPS on the xAI origin (https://auth.x.ai or *.x.ai).
	const iss = typeof claims.iss === "string" ? claims.iss : "";
	let issUrl: URL | undefined;
	try {
		issUrl = new URL(iss);
	} catch {
		// unparseable issuer URL, fall through to the rejection below
	}
	if (!issUrl || !isXaiOrigin(issUrl)) {
		throw new XaiOAuthError(
			`xAI id_token has unexpected issuer: ${iss}`,
			XaiErrorCode.ID_TOKEN_INVALID,
		);
	}

	// Audience must include our client_id.
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!aud.some((a) => a === CLIENT_ID)) {
		throw new XaiOAuthError(
			"xAI id_token audience does not include our client_id.",
			XaiErrorCode.ID_TOKEN_INVALID,
		);
	}

	// Only enforce nonce binding when we actually sent one (browser exchange).
	// Device and refresh callers pass `expectedNonce=""` because they never
	// established a nonce with the AS: a claim that happens to be present on
	// those tokens isn't bound to anything we know, and checking it would
	// either pass trivially or fail spuriously on every refresh if the AS
	// starts echoing a nonce on rotated tokens.
	if (expectedNonce !== "" && typeof claims.nonce === "string" && claims.nonce !== expectedNonce) {
		throw new XaiOAuthError(
			"xAI id_token nonce mismatch: possible token injection.",
			XaiErrorCode.ID_TOKEN_INVALID,
		);
	}

	// If exp is present, it must be in the future, within clock-skew tolerance.
	if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now() - ID_TOKEN_CLOCK_SKEW_MS) {
		throw new XaiOAuthError(
			"xAI id_token has expired.",
			XaiErrorCode.ID_TOKEN_INVALID,
		);
	}
}

// ─── id_token signature verification ───────────────────────────────────────

/** Pinned expected signing algorithm for xAI id_tokens. */
const ID_TOKEN_EXPECTED_ALG = "ES256";

/** Header parameters that override or extend verification semantics.
 * `b64: false` would let an attacker claim the payload isn't base64url-encoded
 * and slip content past the signature check on a future code path that
 * branches on it; the others redirect key resolution or extend the header. */
const ID_TOKEN_FORBIDDEN_HEADER_PARAMS = ["crit", "jku", "jwk", "x5u", "x5c", "x5t", "b64"] as const;

/** JWKS entries from xAI carry `kid` at runtime; TS's `JsonWebKey` type
 * omits it, so we extend the type rather than casting at each use. */
interface XaiJwk extends JsonWebKey {
	kid?: string;
}

/** In-memory JWKS cache. Bounded by TTL so a key rotation propagates. */
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour
let jwksCache: { uri: string; keys: XaiJwk[]; fetchedAt: number } | null = null;

/** Return the cached JWKS for the current URI, or null when no fetch has run. */
export function getCachedJwks(): XaiJwk[] | null {
	return jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS ? jwksCache.keys : null;
}

/** Drop the JWKS cache. Tests only. */
export function resetJwksCacheForTests(): void {
	jwksCache = null;
}

/** Accepted Content-Type values for a JWKS response (RFC 7517 §5). */
const JWKS_CONTENT_TYPES = new Set(["application/json", "application/jwk-set+json"]);

/** Reject a JWKS body larger than this before parsing. */
const JWKS_MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Fetch and cache the JWKS for `jwksUri`.
 *
 * The URI must already be pinned to the xAI origin (validated by discover()).
 * The response must be `application/json` or `application/jwk-set+json` with a
 * `keys` array. Private-key parameters (`d` on EC keys) are dropped: a public
 * key set has no business carrying them, and their presence would let a
 * compromised endpoint hand us a key it controls end-to-end.
 *
 * A failed fetch does not poison the cache, so the next call retries.
 * Pass `force: true` to bypass the TTL (used once on kid-miss during verify).
 */
export async function fetchJwks(jwksUri: string, opts: { force?: boolean } = {}): Promise<XaiJwk[]> {
	// Defense in depth: discover() validates the URI before caching it, but
	// fetchJwks is also exported, so reject non-xAI origins here too. A
	// caller can't accidentally (or maliciously) point verification at an
	// off-origin key set.
	validateEndpoint(jwksUri, "jwks_uri");

	if (
		!opts.force
		&& jwksCache
		&& jwksCache.uri === jwksUri
		&& Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS
	) {
		return jwksCache.keys;
	}

	let response: Response;
	try {
		response = await safeFetch(jwksUri, {
			headers: { Accept: "application/json, application/jwk-set+json" },
			signal: AbortSignal.timeout(10_000),
		});
	} catch (cause) {
		throw new XaiOAuthError(
			`xAI JWKS fetch failed: ${cause instanceof Error ? cause.message : String(cause)}`,
			XaiErrorCode.ID_TOKEN_INVALID,
		);
	}
	if (!response.ok) {
		throw new XaiOAuthError(
			`xAI JWKS fetch returned ${response.status}`,
			XaiErrorCode.ID_TOKEN_INVALID,
		);
	}
	const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (!contentType || !JWKS_CONTENT_TYPES.has(contentType)) {
		throw new XaiOAuthError(
			"xAI JWKS response was not application/json or application/jwk-set+json.",
			XaiErrorCode.ID_TOKEN_INVALID,
		);
	}
	let text: string;
	try {
		text = await readBoundedText(response, JWKS_MAX_RESPONSE_BYTES);
	} catch (cause) {
		throw new XaiOAuthError(
			`xAI JWKS response exceeded the size limit or was unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
			XaiErrorCode.ID_TOKEN_INVALID,
		);
	}
	let parsed: unknown;
	try {
		// JWKS is a small, flat key set; shared defaults are enough.
		parsed = parseBoundedJson(text);
	} catch (cause) {
		throw new XaiOAuthError(
			`xAI JWKS response was not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
			XaiErrorCode.ID_TOKEN_INVALID,
		);
	}
	const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: null;
	const keysRaw = obj?.keys;
	if (!Array.isArray(keysRaw)) {
		throw new XaiOAuthError(
			"xAI JWKS response did not contain a keys array.",
			XaiErrorCode.ID_TOKEN_INVALID,
		);
	}
	const keys = keysRaw.filter((k): k is XaiJwk =>
		!!k && typeof k === "object" && !Array.isArray(k) && !("d" in k),
	).map((k) => k as XaiJwk);

	jwksCache = { uri: jwksUri, keys, fetchedAt: Date.now() };
	return keys;
}

/** Decode the protected header of a JWT without verifying it. */
function decodeJwtHeader(token: string): Record<string, unknown> | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		const b64 = parts[0]!.replace(/-/g, "+").replace(/_/g, "/");
		const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
		return JSON.parse(atob(padded)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function base64urlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
	const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
	const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
	const binary = atob(padded);
	const buffer = new ArrayBuffer(binary.length);
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * Verify an id_token's ES256 signature against the JWKS at `jwksUri`.
 *
 * The token's header must declare `alg: ES256`, must not carry any header
 * parameter that could redirect key resolution (`jku`, `jwk`, `x5u`, `x5c`,
 * `x5t`) or extension (`crit`), and must reference a key in the JWKS by `kid`
 * (or, when `kid` is absent, resolve against a single-key JWKS). The signature
 * is then verified with WebCrypto over the SHA-256 hash of the signing input.
 *
 * On kid miss against a cached JWKS, one forced re-fetch runs so a mid-TTL key
 * rotation does not fail every fresh login. A second miss is fatal.
 *
 * Throws ID_TOKEN_SIGNATURE_INVALID for signature/key failures, and
 * ID_TOKEN_INVALID for malformed tokens or forbidden header params.
 */
export async function verifyIdTokenSignature(idToken: string, jwksUri: string): Promise<void> {
	const parts = idToken.split(".");
	if (parts.length !== 3) {
		throw new XaiOAuthError(
			"xAI id_token is not a signed JWT.",
			XaiErrorCode.ID_TOKEN_INVALID,
		);
	}
	const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

	const header = decodeJwtHeader(idToken);
	if (!header) {
		throw new XaiOAuthError(
			"xAI id_token header was unparseable.",
			XaiErrorCode.ID_TOKEN_INVALID,
		);
	}
	if (header.alg !== ID_TOKEN_EXPECTED_ALG) {
		throw new XaiOAuthError(
			`xAI id_token header declared alg \`${header.alg ?? "(missing)"}\`, expected ${ID_TOKEN_EXPECTED_ALG}.`,
			XaiErrorCode.ID_TOKEN_INVALID,
		);
	}
	for (const param of ID_TOKEN_FORBIDDEN_HEADER_PARAMS) {
		if (param in header) {
			throw new XaiOAuthError(
				`xAI id_token header carries unsupported parameter \`${param}\`.`,
				XaiErrorCode.ID_TOKEN_INVALID,
			);
		}
	}

	const kid = typeof header.kid === "string" ? header.kid : undefined;
	let keys = await fetchJwks(jwksUri);
	let candidates = kid ? keys.filter((k) => k.kid === kid) : keys;

	// Key rotation can land a new kid while the TTL still holds the old set.
	// Force one uncached fetch on miss, then fail if the kid is still absent.
	if (candidates.length === 0 && kid) {
		keys = await fetchJwks(jwksUri, { force: true });
		candidates = keys.filter((k) => k.kid === kid);
	}

	if (candidates.length === 0) {
		throw new XaiOAuthError(
			kid ? `xAI id_token kid \`${kid}\` is not present in the JWKS.` : "xAI JWKS has no keys to match against.",
			XaiErrorCode.ID_TOKEN_SIGNATURE_INVALID,
		);
	}
	if (!kid && candidates.length > 1) {
		throw new XaiOAuthError(
			"xAI id_token header omitted kid but the JWKS contains multiple keys.",
			XaiErrorCode.ID_TOKEN_SIGNATURE_INVALID,
		);
	}

	const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const signature = base64urlToBytes(sigB64);

	let verified = false;
	for (const candidate of candidates) {
		try {
			const key = await crypto.subtle.importKey(
				"jwk",
				candidate,
				{ name: "ECDSA", namedCurve: "P-256" },
				false,
				["verify"],
			);
			if (await crypto.subtle.verify(
				{ name: "ECDSA", hash: "SHA-256" },
				key,
				signature,
				signingInput,
			)) {
				verified = true;
				break;
			}
		} catch {
			// Skip keys that fail to import (wrong kty/crv/params). A well-formed
			// JWKS won't include them, but a malformed one should not crash login.
		}
	}
	if (!verified) {
		throw new XaiOAuthError(
			"xAI id_token signature did not verify against the pinned JWKS.",
			XaiErrorCode.ID_TOKEN_SIGNATURE_INVALID,
		);
	}
}

// ─── Token exchange ──────────────────────────────────────────────────────────

async function exchangeCode(
	tokenEndpoint: string,
	code: string,
	redirectUri: string,
	verifier: string,
	expectedNonce: string,
	jwksUri: string,
): Promise<XaiOAuthCredentials> {
	const response = await safeFetch(tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		}),
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		// Surface only the OAuth error code from the body (invalid_grant,
		// invalid_client, etc.); drop the free-text error_description and any
		// non-JSON body so upstream wording never lands in the user-facing
		// message.
		const errText = await readBoundedText(response, AUTH_MAX_RESPONSE_BYTES).catch(() => "");
		let oauthError = "";
		try { oauthError = String((JSON.parse(errText) as { error?: unknown }).error ?? ""); } catch { /* non-JSON */ }
		const cls = classifyHttpStatus(response.status);
		throw new XaiOAuthError(
			`xAI token exchange failed: ${oauthError || cls.label}`,
			XaiErrorCode.TOKEN_EXCHANGE_FAILED,
			cls.fatal,
		);
	}
	let payload: Record<string, unknown>;
	try {
		payload = (await readBoundedJson(response, AUTH_MAX_RESPONSE_BYTES)) as Record<string, unknown>;
	} catch (cause) {
		throw new XaiOAuthError(
			`xAI token exchange returned an unparseable body: ${cause instanceof Error ? cause.message : String(cause)}`,
			XaiErrorCode.TOKEN_EXCHANGE_INVALID,
		);
	}
	const access = String(payload.access_token ?? "");
	const refresh = String(payload.refresh_token ?? "");
	if (!access) {
		throw new XaiOAuthError(
			"xAI token exchange did not return access_token.",
			XaiErrorCode.TOKEN_EXCHANGE_INVALID,
		);
	}
	if (!refresh) {
		throw new XaiOAuthError(
			"xAI token exchange did not return refresh_token.",
			XaiErrorCode.TOKEN_EXCHANGE_INVALID,
		);
	}
	const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in ?? 3600);
	const idToken = String(payload.id_token ?? "");
	if (idToken) {
		validateIdToken(idToken, expectedNonce);
		await verifyIdTokenSignature(idToken, jwksUri);
	}
	return {
		access,
		refresh,
		expires: computeExpires(access, expiresIn),
		tokenEndpoint,
		idToken,
		tokenType: String(payload.token_type ?? "Bearer"),
		baseUrl: getBaseUrl(),
	};
}

// ─── Device-code login ─────────────────────────────────────────────────────

interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	expires_in: number;
	interval?: number;
}

async function requestDeviceCode(signal?: AbortSignal): Promise<DeviceCodeResponse> {
	const body = new URLSearchParams({
		client_id: CLIENT_ID,
		scope: SCOPE,
		referrer: "grok-build",
	});
	const response = await safeFetch(DEVICE_CODE_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"x-grok-client-version": CLIENT_VERSION,
			"x-grok-client-surface": "cli",
		},
		body,
		signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
	});
	if (!response.ok) {
		const errText = await readBoundedText(response, AUTH_MAX_RESPONSE_BYTES).catch(() => "");
		let oauthError = "";
		try { oauthError = String((JSON.parse(errText) as { error?: unknown }).error ?? ""); } catch { /* non-JSON */ }
		const cls = classifyHttpStatus(response.status);
		throw new XaiOAuthError(
			`xAI device-code request failed: ${oauthError || cls.label}`,
			XaiErrorCode.DEVICE_CODE_FAILED,
			cls.fatal,
		);
	}
	try {
		return (await readBoundedJson(response, AUTH_MAX_RESPONSE_BYTES)) as DeviceCodeResponse;
	} catch (cause) {
		throw new XaiOAuthError(
			`xAI device-code response was not parseable: ${cause instanceof Error ? cause.message : String(cause)}`,
			XaiErrorCode.DEVICE_CODE_FAILED,
		);
	}
}

/** Run the OAuth 2.0 device-authorization grant. Surfaces the verification URI
 * and user code via onAuth, then polls the token endpoint until the user
 * approves, denies, or the code expires. No loopback server, no paste. */
export async function loginDeviceCode(
	callbacks: import("@earendil-works/pi-ai").OAuthLoginCallbacks,
): Promise<import("@earendil-works/pi-ai").OAuthCredentials> {
	const { signal } = callbacks;
	if (signal?.aborted) throw outcomeToError({ kind: "cancelled" });

	// Resolve discovery up front so the device flow can verify the id_token
	// signature against the pinned JWKS, the same way the browser flow does.
	// A discovery failure fails the login rather than silently skipping
	// signature verification.
	const discovery = await discover();

	const device = await requestDeviceCode(signal);
	const display = device.verification_uri_complete ?? device.verification_uri;
	// Surface the code to the host. Newer pi-coding-agent (0.80+) provides
	// onDeviceCode, which renders a dedicated TUI: clickable hyperlink,
	// highlighted code, and a waiting indicator. Older hosts only have onAuth,
	// which renders the URL generically. Feature-detect at runtime so we get
	// the polished UI when available without forcing a dependency bump.
	type DeviceCodeInfo = {
		userCode: string;
		verificationUri: string;
		intervalSeconds?: number;
		expiresInSeconds?: number;
	};
	type CallbacksWithDeviceCode = import("@earendil-works/pi-ai").OAuthLoginCallbacks & {
		onDeviceCode?: (info: DeviceCodeInfo) => void;
	};
	const cb = callbacks as CallbacksWithDeviceCode;
	if (typeof cb.onDeviceCode === "function") {
		cb.onDeviceCode({
			userCode: device.user_code,
			verificationUri: display,
			intervalSeconds: device.interval,
			expiresInSeconds: device.expires_in,
		});
	} else {
		// Fallback for older hosts without onDeviceCode. The host shows a manual
		// paste prompt here because usesCallbackServer is true (set for the
		// browser flow). Device code ignores any pasted value, but we must
		// consume onManualCodeInput so an Escape during the paste prompt does
		// not surface as an unhandled rejection and crash pi. The actual cancel
		// propagates via callbacks.signal, which the poll loop watches.
		callbacks.onAuth({
			url: display,
			instructions: `Open ${display} and enter code ${device.user_code}. Or approve at ${device.verification_uri}.`,
		});
		if (typeof callbacks.onManualCodeInput === "function") {
			callbacks.onManualCodeInput().catch(() => { /* cancel handled via signal */ });
		}
	}

	let interval = Math.max(1, device.interval ?? 5);
	const deadline = Date.now() + Math.max(device.expires_in, 60) * 1000;
	// Sleep between polls, rejecting early if the login is cancelled. The abort
	// listener is removed when the timer wins so a long poll loop does not pile
	// closures onto the login signal; an already-aborted login rejects at once.
	const sleep = (ms: number): Promise<void> => {
		if (signal?.aborted) return Promise.reject(outcomeToError({ kind: "cancelled" }));
		return new Promise<void>((resolve, reject) => {
			const onAbort = () => { clearTimeout(t); reject(outcomeToError({ kind: "cancelled" })); };
			const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	};

	for (;;) {
		// Sleep first: an immediate poll on a fresh code only returns pending.
		await sleep(interval * 1000);
		if (Date.now() > deadline) {
			throw new XaiOAuthError(
				"xAI device code expired. Restart /login.",
				XaiErrorCode.DEVICE_CODE_FAILED,
				true,
			);
		}

		const response = await safeFetch(DEVICE_TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"x-grok-client-version": CLIENT_VERSION,
				"x-grok-client-surface": "cli",
			},
			body: new URLSearchParams({
				grant_type: DEVICE_GRANT_TYPE,
				device_code: device.device_code,
				client_id: CLIENT_ID,
			}),
			signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
		});

		if (response.ok) {
			let payload: Record<string, unknown>;
			try {
				payload = (await readBoundedJson(response, AUTH_MAX_RESPONSE_BYTES)) as Record<string, unknown>;
			} catch (cause) {
				throw new XaiOAuthError(
					`xAI device token response was not parseable: ${cause instanceof Error ? cause.message : String(cause)}`,
					XaiErrorCode.DEVICE_CODE_FAILED,
					true,
				);
			}
			return await shapeDeviceToken(payload, DEVICE_TOKEN_URL, discovery.jwks_uri);
		}

		let errBody: { error?: string; error_description?: string } = {};
		const errText = await readBoundedText(response, AUTH_MAX_RESPONSE_BYTES).catch(() => "");
		try { errBody = JSON.parse(errText); } catch { /* non-JSON error */ }
		switch (errBody.error) {
			case "authorization_pending":
				continue;
			case "slow_down":
				interval += 5;
				continue;
			case "access_denied":
				throw new XaiOAuthError(
					"xAI device login denied.",
					XaiErrorCode.DEVICE_CODE_FAILED,
					true,
				);
			case "expired_token":
				throw new XaiOAuthError(
					"xAI device code expired. Restart /login.",
					XaiErrorCode.DEVICE_CODE_FAILED,
					true,
				);
			default:
				throw new XaiOAuthError(
					`xAI device token exchange failed: ${errBody.error ?? response.status}`,
					XaiErrorCode.DEVICE_CODE_FAILED,
				);
		}
	}
}

/** Shape a device-flow token response into stored credentials. Mirrors the
 * exchange path: validates the id_token when present (device flow carries no
 * nonce, and validateIdToken only checks nonce when the claim is present),
 * then verifies the id_token signature against the pinned JWKS. */
async function shapeDeviceToken(
	payload: Record<string, unknown>,
	tokenEndpoint: string,
	jwksUri: string,
): Promise<import("@earendil-works/pi-ai").OAuthCredentials> {
	const access = String(payload.access_token ?? "");
	if (!access) {
		throw new XaiOAuthError(
			"xAI device login did not return access_token.",
			XaiErrorCode.DEVICE_CODE_FAILED,
			true,
		);
	}
	const refresh = String(payload.refresh_token ?? "");
	if (!refresh) {
		throw new XaiOAuthError(
			"xAI device login did not return refresh_token.",
			XaiErrorCode.DEVICE_CODE_FAILED,
			true,
		);
	}
	const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in ?? 3600);
	const idToken = String(payload.id_token ?? "");
	if (idToken) {
		validateIdToken(idToken, "");
		await verifyIdTokenSignature(idToken, jwksUri);
	}
	return {
		access,
		refresh,
		expires: computeExpires(access, expiresIn),
		tokenEndpoint,
		idToken,
		tokenType: String(payload.token_type ?? "Bearer"),
		baseUrl: getBaseUrl(),
	};
}

// ─── Login (called by pi's /login flow) ──────────────────────────────────────

export async function login(
	callbacks: import("@earendil-works/pi-ai").OAuthLoginCallbacks,
): Promise<import("@earendil-works/pi-ai").OAuthCredentials> {
	const { signal } = callbacks;
	if (signal?.aborted) throw outcomeToError({ kind: "cancelled" });

	// Flow choice: the env var is an explicit override in either direction.
	// Unset (or any value other than browser/callback), device code is the
	// default. It works everywhere (no loopback port, no callback server, no
	// local browser), and newer pi-coding-agent renders it with a dedicated TUI
	// via onDeviceCode. Browser flow stays available for users who prefer the
	// auto-redirect, typically on a local machine.
	const method = (process.env.PI_XAI_LOGIN_METHOD || "device").toLowerCase();
	if (method !== "browser" && method !== "callback") {
		return loginDeviceCode(callbacks);
	}

	const discovery = await discover();
	const { verifier, challenge } = await generatePKCE();
	const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
	const nonce = base64Url(crypto.getRandomValues(new Uint8Array(16)));
	const callback = await startCallbackServer();

	try {
		// Build authorize URL
		const authUrl = new URL(discovery.authorization_endpoint);
		authUrl.searchParams.set("response_type", "code");
		authUrl.searchParams.set("client_id", CLIENT_ID);
		authUrl.searchParams.set("redirect_uri", callback.redirectUri);
		authUrl.searchParams.set("scope", SCOPE);
		authUrl.searchParams.set("code_challenge", challenge);
		authUrl.searchParams.set("code_challenge_method", "S256");
		authUrl.searchParams.set("state", state);
		authUrl.searchParams.set("nonce", nonce);
		// `plan=generic` opts into xAI's generic OAuth plan tier.
		authUrl.searchParams.set("plan", "generic");
		authUrl.searchParams.set("referrer", "pi-grok");

		callbacks.onAuth({
			url: authUrl.toString(),
			instructions: `Authorize xAI, then return to pi. Callback listener: ${callback.redirectUri}`,
		});

		// Optional manual-paste promise (races with the callback server).
		// Consume it here so a user-initiated cancel (Escape) rejects the
		// promise instead of becoming an unhandled rejection that crashes pi.
		let manualCode: string | undefined;
		let manualError: Error | undefined;
		const manualPromise = callbacks.onManualCodeInput
			? callbacks.onManualCodeInput()
				.then((input) => {
					manualCode = input;
				})
				.catch((err) => {
					manualError = err instanceof Error ? err : new Error(String(err));
				})
			: undefined;

		// First to settle wins. When a manual-paste promise is wired we race
		// it against the callback wait on a private AbortController, so when
		// the paste wins we abort the losing callback wait and tear down its
		// 180s timer + listener instead of leaving them to fire into the void.
		// The login signal is forwarded so an external cancel reaches the wait.
		let outcome: CallbackOutcome | undefined;
		if (manualPromise) {
			const callbackAbort = new AbortController();
			const onLoginAbort = () => callbackAbort.abort();
			if (signal) {
				if (signal.aborted) callbackAbort.abort();
				signal.addEventListener("abort", onLoginAbort, { once: true });
			}
			await Promise.race([
				callback.waitForCallback(180_000, callbackAbort.signal).then((o) => { outcome = o; }),
				manualPromise,
			]);
			callbackAbort.abort();
			signal?.removeEventListener("abort", onLoginAbort);
		} else {
			outcome = await callback.waitForCallback(180_000, signal);
		}

		// Escape was pressed in the paste prompt; propagate the cancel.
		if (manualError) {
			throw manualError;
		}

		// Paste won the race before the browser callback fired. Normalize it to
		// an `ok` outcome so it flows through the same validation and exchange
		// as the browser path. State is checked only when the pasted value
		// carried one. A bare code paste is the user opting out of
		// the CSRF check, trusting PKCE + the one-time code binding instead.
		if (!outcome && manualCode) {
			const parsed = parseRedirectUrl(manualCode);
			if (parsed.state && parsed.state !== state) {
				throw new XaiOAuthError(
					"xAI OAuth state mismatch: possible CSRF.",
					XaiErrorCode.STATE_MISMATCH,
				);
			}
			if (!parsed.code) {
				throw new XaiOAuthError(
					"xAI OAuth paste did not include an authorization code.",
					XaiErrorCode.CODE_MISSING,
				);
			}
			outcome = { kind: "ok", code: parsed.code, state: parsed.state ?? state };
		}

		// Capture the settled outcome before any await. When the manual path
		// won, aborting the callback wait above resolves its abandoned promise
		// to `cancelled` on a later microtask; reading through `resolved` keeps
		// that late overwrite from racing the checks below.
		const resolved = outcome;
		if (!resolved || resolved.kind === "cancelled" || resolved.kind === "error") {
			throw outcomeToError(
				resolved ?? { kind: "error", message: "xAI OAuth callback produced no outcome." },
			);
		}

		// Validate the CSRF state and code presence, then exchange. These
		// carry distinct codes (STATE_MISMATCH, CODE_MISSING) that
		// outcomeToError's single AUTHORIZATION_FAILED would collapse, so they
		// stay direct throws.
		if (resolved.state !== state) {
			throw new XaiOAuthError(
				"xAI OAuth state mismatch: possible CSRF.",
				XaiErrorCode.STATE_MISMATCH,
			);
		}
		if (!resolved.code) {
			throw new XaiOAuthError(
				"xAI OAuth callback did not include an authorization code.",
				XaiErrorCode.CODE_MISSING,
			);
		}

		callbacks.onProgress?.("Exchanging authorization code for tokens...");
		const credentials = await exchangeCode(
			discovery.token_endpoint,
			resolved.code,
			callback.redirectUri,
			verifier,
			nonce,
			discovery.jwks_uri,
		);
		credentials.discovery = discovery;
		return credentials;
	} finally {
		if (callback.server.listening) callback.server.close();
	}
}

// ─── Token refresh ────────────────────────────────────────────────────────────

/** In-flight refreshes keyed by refresh token. The token is single-use, so two
 * concurrent refreshes with the same token race and the loser fails with a
 * 400/401. Coalescing parallel calls onto one network request avoids that; the
 * key is the refresh token so distinct sessions do not block each other. */
const refreshLocks = new Map<string, Promise<import("@earendil-works/pi-ai").OAuthCredentials>>();

async function withRefreshLock(
	key: string,
	fn: () => Promise<import("@earendil-works/pi-ai").OAuthCredentials>,
): Promise<import("@earendil-works/pi-ai").OAuthCredentials> {
	const existing = refreshLocks.get(key);
	if (existing) return existing;
	const p = (async () => {
		try {
			return await fn();
		} finally {
			refreshLocks.delete(key);
		}
	})();
	refreshLocks.set(key, p);
	return p;
}

export async function refresh(
	credentials: import("@earendil-works/pi-ai").OAuthCredentials,
): Promise<import("@earendil-works/pi-ai").OAuthCredentials> {
	if (!credentials.refresh) {
		throw new XaiOAuthError(
			"Missing refresh_token. Re-login required.",
			XaiErrorCode.REFRESH_MISSING,
			true,
		);
	}
	return withRefreshLock(credentials.refresh, () => refreshOnce(credentials));
}

async function refreshOnce(
	credentials: import("@earendil-works/pi-ai").OAuthCredentials,
): Promise<import("@earendil-works/pi-ai").OAuthCredentials> {
	const xai = credentials as XaiOAuthCredentials;
	const tokenEndpoint = xai.tokenEndpoint || xai.discovery?.token_endpoint || (await discover()).token_endpoint;
	validateEndpoint(tokenEndpoint, "token_endpoint");

	const response = await safeFetch(tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: credentials.refresh,
		}),
		signal: AbortSignal.timeout(15_000),
	});

	if (!response.ok) {
		// Classify by the OAuth error code in the body, not the HTTP status:
		// `invalid_grant` (revoked/expired refresh token) and `invalid_client`
		// are terminal and need a re-login, while a 400/403 from a transient
		// server fault should stay retryable. Anything unparseable is treated as
		// retryable so a blip doesn't force a re-login. The free-text
		// error_description never lands in the message; only the stable OAuth
		// error code or a status label surfaces.
		let errBody: { error?: string } = {};
		const text = await readBoundedText(response, AUTH_MAX_RESPONSE_BYTES).catch(() => "");
		try { errBody = JSON.parse(text); } catch { /* non-JSON error body */ }
		const code = typeof errBody.error === "string" ? errBody.error : "";
		const isFatal = code === "invalid_grant" || code === "invalid_client";
		const cls = classifyHttpStatus(response.status);
		const detail = code || cls.label;
		throw new XaiOAuthError(
			`xAI token refresh failed: ${detail}`,
			XaiErrorCode.REFRESH_FAILED,
			isFatal,
		);
	}

	let payload: Record<string, unknown>;
	try {
		payload = (await readBoundedJson(response, AUTH_MAX_RESPONSE_BYTES)) as Record<string, unknown>;
	} catch (cause) {
		throw new XaiOAuthError(
			`xAI token refresh returned an unparseable body: ${cause instanceof Error ? cause.message : String(cause)}`,
			XaiErrorCode.REFRESH_FAILED,
			true,
		);
	}
	const access = String(payload.access_token ?? "");
	if (!access) {
		throw new XaiOAuthError(
			"xAI token refresh did not return access_token.",
			XaiErrorCode.REFRESH_FAILED,
			true,
		);
	}

	const refresh_new = String(payload.refresh_token ?? credentials.refresh);
	const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in ?? 3600);

	// When the AS rotates the id_token on refresh, re-validate claims and
	// signature the same way login does. Fall back to the previous id_token
	// when the response omits one.
	const previousIdToken = typeof xai.idToken === "string" ? xai.idToken : "";
	const idToken = String(payload.id_token ?? previousIdToken);
	if (payload.id_token) {
		const jwksUri = xai.discovery?.jwks_uri || (await discover()).jwks_uri;
		validateIdToken(idToken, "");
		await verifyIdTokenSignature(idToken, jwksUri);
	}

	return {
		...xai,
		access,
		refresh: refresh_new,
		expires: computeExpires(access, expiresIn),
		tokenEndpoint,
		idToken,
		tokenType: String(payload.token_type ?? xai.tokenType ?? "Bearer"),
		baseUrl: getBaseUrl(),
	};
}

/**
 * xAI Grok OAuth 2.0 + PKCE implementation.
 *
 * Uses Web Crypto API (crypto.subtle) for PKCE so the extension is
 * portable across Node versions and potential non-Node runtimes.
 *
 * Based on the Hermes agent xai-oauth flow, adapted for the pi SDK.
 */

import { createServer } from "node:http";
import { XaiErrorCode, XaiOAuthError } from "./errors.js";

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
const SCOPE = process.env.PI_XAI_OAUTH_SCOPE || "openid profile email offline_access grok-cli:access api:access";
const CALLBACK_HOST = process.env.PI_XAI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const DEFAULT_CALLBACK_PORT = 56121;
const CALLBACK_PORT = parseCallbackPort(process.env.PI_XAI_OAUTH_CALLBACK_PORT);
const CALLBACK_PATH = "/callback";
/** Refresh 5 min before actual expiry. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
/** Tolerance for id_token exp against issuer clock drift. */
const ID_TOKEN_CLOCK_SKEW_MS = 30_000;

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
		response = await fetch(DISCOVERY_URL, {
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
	const payload = (await response.json()) as Record<string, unknown>;
	const authorizationEndpoint = validateEndpoint(String(payload.authorization_endpoint ?? ""), "authorization_endpoint");
	const tokenEndpoint = validateEndpoint(String(payload.token_endpoint ?? ""), "token_endpoint");
	return { authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint };
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

/**
 * Decode a JWT payload without verifying its signature.
 *
 * We do NOT validate the JWT signature here because pi-grok has no
 * out-of-band channel to fetch xAI's rotating JWKS keys at the moment we
 * need them. The checks we *do* apply (iss, aud, nonce, exp) still close
 * the practical token-injection vectors for an OAuth code flow on a
 * loopback redirect. Signature verification would be a future hardening
 * step requiring a JWKS fetch + cache.
 */
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

/** True when the access token is expired or within `skewMs` of expiry. Returns
 * false when the token carries no `exp` (no basis to force a refresh). */
export function isAccessTokenExpiring(token: string, skewMs: number = REFRESH_SKEW_MS): boolean {
	const exp = decodeJwtExp(token);
	if (exp === null) return false;
	return exp * 1000 <= Date.now() + Math.max(0, skewMs);
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
 * Validate the id_token returned in the token exchange.
 *
 * - `iss` must be the xAI issuer (or a sub-path of it).
 * - `aud` must contain our client_id.
 * - `nonce`, if present, must match the one sent in the authorize request.
 *   (Checked conditionally so a provider that omits the claim does not fail;
 *   PKCE plus the one-time code still bind the exchange.)
 * - `exp`, if present, must be in the future (30s clock skew allowed).
 *
 * Returns on success; throws `ID_TOKEN_INVALID` on any mismatch.
 * If no id_token is present, this is a no-op (the provider may legitimately
 * omit it).
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

	// If a nonce claim is present, it must match the one we sent. Not all
	// providers return nonce; when absent, PKCE + one-time code still bind.
	if (typeof claims.nonce === "string" && claims.nonce !== expectedNonce) {
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

// ─── Token exchange ───────────────────────────────────────────────────────────

async function exchangeCode(
	tokenEndpoint: string,
	code: string,
	redirectUri: string,
	verifier: string,
	expectedNonce: string,
): Promise<XaiOAuthCredentials> {
	const response = await fetch(tokenEndpoint, {
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
		throw new XaiOAuthError(
			`xAI token exchange failed: ${response.status} ${await response.text()}`,
			XaiErrorCode.TOKEN_EXCHANGE_FAILED,
		);
	}
	const payload = (await response.json()) as Record<string, unknown>;
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
	const response = await fetch(DEVICE_CODE_URL, {
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
		throw new XaiOAuthError(
			`xAI device-code request failed: ${response.status} ${await response.text()}`,
			XaiErrorCode.DEVICE_CODE_FAILED,
		);
	}
	return (await response.json()) as DeviceCodeResponse;
}

/** Run the OAuth 2.0 device-authorization grant. Surfaces the verification URI
 * and user code via onAuth, then polls the token endpoint until the user
 * approves, denies, or the code expires. No loopback server, no paste. */
export async function loginDeviceCode(
	callbacks: import("@earendil-works/pi-ai").OAuthLoginCallbacks,
): Promise<import("@earendil-works/pi-ai").OAuthCredentials> {
	const { signal } = callbacks;
	if (signal?.aborted) throw outcomeToError({ kind: "cancelled" });

	const device = await requestDeviceCode(signal);
	const display = device.verification_uri_complete ?? device.verification_uri;
	callbacks.onAuth({
		url: display,
		instructions: `Open ${display} and enter code ${device.user_code}. Or approve at ${device.verification_uri}.`,
	});

	let interval = Math.max(1, device.interval ?? 5);
	const deadline = Date.now() + Math.max(device.expires_in, 60) * 1000;
	const sleep = (ms: number) =>
		new Promise<void>((resolve, reject) => {
			const t = setTimeout(resolve, ms);
			signal?.addEventListener("abort", () => { clearTimeout(t); reject(outcomeToError({ kind: "cancelled" })); }, { once: true });
		});

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

		const response = await fetch(DEVICE_TOKEN_URL, {
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
			const payload = (await response.json()) as Record<string, unknown>;
			return shapeDeviceToken(payload, DEVICE_TOKEN_URL);
		}

		let errBody: { error?: string; error_description?: string } = {};
		try { errBody = await response.json(); } catch { /* non-JSON error */ }
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
 * nonce, and validateIdToken only checks nonce when the claim is present). */
function shapeDeviceToken(
	payload: Record<string, unknown>,
	tokenEndpoint: string,
): import("@earendil-works/pi-ai").OAuthCredentials {
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
	if (idToken) validateIdToken(idToken, "");
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

	// Device-code flow for headless/SSH boxes where a loopback callback is
	// awkward. Opt in with PI_XAI_LOGIN_METHOD=device; everything else uses
	// the browser callback + manual-paste race below.
	if ((process.env.PI_XAI_LOGIN_METHOD || "").toLowerCase() === "device") {
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

	const response = await fetch(tokenEndpoint, {
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
		const isFatal = response.status === 400 || response.status === 401 || response.status === 403;
		throw new XaiOAuthError(
			`xAI token refresh failed: ${response.status} ${await response.text()}`,
			XaiErrorCode.REFRESH_FAILED,
			isFatal,
		);
	}

	const payload = (await response.json()) as Record<string, unknown>;
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

	return {
		...xai,
		access,
		refresh: refresh_new,
		expires: computeExpires(access, expiresIn),
		tokenEndpoint,
		idToken: String(payload.id_token ?? xai.idToken ?? ""),
		tokenType: String(payload.token_type ?? xai.tokenType ?? "Bearer"),
		baseUrl: getBaseUrl(),
	};
}

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
const CLIENT_ID = process.env.PI_XAI_OAUTH_CLIENT_ID || "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = process.env.PI_XAI_OAUTH_SCOPE || "openid profile email offline_access grok-cli:access api:access";
const CALLBACK_HOST = process.env.PI_XAI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = Number.parseInt(process.env.PI_XAI_OAUTH_CALLBACK_PORT || "56121", 10);
const CALLBACK_PATH = "/callback";
/** Refresh 5 min before actual expiry. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

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
 * redirect, a `code=...&state=...` querystring, or just the raw code.
 */
function parseRedirectUrl(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL — fall through
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
 * Refuse any OIDC endpoint that isn't HTTPS on the xAI origin.
 *
 * The cached discovery response is long-lived in auth.json.  A single MITM
 * during initial login could substitute a malicious token_endpoint that would
 * receive every subsequent refresh_token.  Validating scheme + host pins the
 * endpoint to x.ai / *.x.ai so cache poisoning can't persist.
 */
function validateEndpoint(value: string, field: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new XaiOAuthError(
			`xAI OAuth discovery returned invalid ${field}: ${value}`,
			XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
		);
	}
	if (url.protocol !== "https:") {
		throw new XaiOAuthError(
			`xAI OAuth ${field} must use HTTPS: ${value}`,
			XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
		);
	}
	const host = url.hostname.toLowerCase();
	if (host !== "x.ai" && host !== "auth.x.ai" && host !== "accounts.x.ai" && !host.endsWith(".x.ai")) {
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

interface CallbackResult {
	code?: string;
	state?: string;
	error?: string;
	errorDescription?: string;
}

function startCallbackServer(): Promise<{
	server: import("node:http").Server;
	redirectUri: string;
	waitForCallback: (timeoutMs: number, signal?: AbortSignal) => Promise<CallbackResult>;
}> {
	let settle: ((value: CallbackResult) => void) | undefined;
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
		const redirectUri = `http://${CALLBACK_HOST}:${actualPort}${CALLBACK_PATH}`;
		return {
			server,
			redirectUri,
			waitForCallback: (timeoutMs: number, signal?: AbortSignal) => {
				const branches: Promise<CallbackResult>[] = [
					callbackPromise,
					new Promise<CallbackResult>((resolve) =>
						setTimeout(
							() => resolve({ error: "timeout", errorDescription: "Timed out waiting for xAI OAuth callback." }),
							timeoutMs,
						),
					),
				];
				if (signal) {
					branches.push(
						signal.aborted
							? Promise.resolve({ error: "aborted", errorDescription: "Login cancelled" })
							: new Promise<CallbackResult>((resolve) =>
								signal.addEventListener("abort", () => resolve({ error: "aborted", errorDescription: "Login cancelled" }), { once: true }),
							),
					);
				}
				return Promise.race(branches);
			},
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
function decodeIdToken(token: string): IdTokenClaims | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		// JWT payload is base64url without padding.
		const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
		const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
		const json = atob(padded);
		return JSON.parse(json) as IdTokenClaims;
	} catch {
		return null;
	}
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
 * Returns silently on success; throws `ID_TOKEN_INVALID` on any mismatch.
 * If no id_token is present, this is a no-op (the provider may legitimately
 * omit it).
 */
function validateIdToken(idToken: string, expectedNonce: string): void {
	const claims = decodeIdToken(idToken);
	if (!claims) {
		throw new XaiOAuthError(
			"xAI token exchange returned an unparseable id_token.",
			XaiErrorCode.ID_TOKEN_INVALID,
		);
	}

	// Issuer check: must be https://auth.x.ai or *.x.ai.
	const iss = typeof claims.iss === "string" ? claims.iss : "";
	try {
		const issUrl = new URL(iss);
		const host = issUrl.hostname.toLowerCase();
		if (issUrl.protocol !== "https:" || (!host.endsWith(".x.ai") && host !== "x.ai")) {
			throw 0; // triggers the catch below
		}
	} catch {
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
			"xAI id_token nonce mismatch — possible token injection.",
			XaiErrorCode.ID_TOKEN_INVALID,
		);
	}

	// If exp is present, it must be in the future (30s clock skew allowed).
	if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now() - 30_000) {
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
		expires: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
		tokenEndpoint,
		discovery: { authorization_endpoint: "", token_endpoint: tokenEndpoint },
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
	if (signal?.aborted) throw new Error("Login cancelled");

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

		// First to settle wins. When no manual-paste promise is wired (the
		// caller didn't supply onManualCodeInput), do NOT race against a
		// resolved promise — that would settle before the callback fires and
		// fall through to the state check with `result` still undefined.
		let result: CallbackResult | undefined;
		if (manualPromise) {
			await Promise.race([
				callback.waitForCallback(180_000, signal).then((r) => { result = r; }),
				manualPromise,
			]);
		} else {
			result = await callback.waitForCallback(180_000, signal);
		}

		// Escape was pressed in the paste prompt — propagate the cancel.
		if (manualError) {
			throw manualError;
		}

		// Manual paste won the race before the callback server fired.
		// State is checked only when the pasted value carried one — a bare
		// code paste is the user explicitly opting out of the CSRF check,
		// trusting PKCE + the one-time code binding instead.
		if (!result && manualCode) {
			const parsed = parseRedirectUrl(manualCode);
			if (parsed.state && parsed.state !== state) {
				throw new XaiOAuthError(
					"xAI OAuth state mismatch — possible CSRF.",
					XaiErrorCode.STATE_MISMATCH,
				);
			}
			if (!parsed.code) {
				throw new XaiOAuthError(
					"xAI OAuth paste did not include an authorization code.",
					XaiErrorCode.CODE_MISSING,
				);
			}
			callbacks.onProgress?.("Exchanging authorization code for tokens...");
			const credentials = await exchangeCode(
				discovery.token_endpoint,
				parsed.code,
				callback.redirectUri,
				verifier,
				nonce,
			);
			credentials.discovery = discovery;
			return credentials;
		}

		// Validate browser-callback result
		if (result?.error) {
			throw new XaiOAuthError(
				result.errorDescription ?? result.error,
				XaiErrorCode.AUTHORIZATION_FAILED,
			);
		}
		if (result?.state !== state) {
			throw new XaiOAuthError(
				"xAI OAuth state mismatch — possible CSRF.",
				XaiErrorCode.STATE_MISMATCH,
			);
		}
		if (!result?.code) {
			throw new XaiOAuthError(
				"xAI OAuth callback did not include an authorization code.",
				XaiErrorCode.CODE_MISSING,
			);
		}

		// Exchange code for tokens
		callbacks.onProgress?.("Exchanging authorization code for tokens...");
		const credentials = await exchangeCode(
			discovery.token_endpoint,
			result.code,
			callback.redirectUri,
			verifier,
			nonce,
		);
		credentials.discovery = discovery;
		return credentials;
	} finally {
		callback.server.close();
	}
}

// ─── Token refresh ────────────────────────────────────────────────────────────

export async function refresh(
	credentials: import("@earendil-works/pi-ai").OAuthCredentials,
): Promise<import("@earendil-works/pi-ai").OAuthCredentials> {
	const xai = credentials as XaiOAuthCredentials;
	const tokenEndpoint = xai.tokenEndpoint || xai.discovery?.token_endpoint || (await discover()).token_endpoint;
	validateEndpoint(tokenEndpoint, "token_endpoint");

	if (!credentials.refresh) {
		throw new XaiOAuthError(
			"Missing refresh_token. Re-login required.",
			XaiErrorCode.REFRESH_MISSING,
			true,
		);
	}

	const response = await fetch(tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: credentials.refresh,
		}),
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
		expires: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
		tokenEndpoint,
		idToken: String(payload.id_token ?? xai.idToken ?? ""),
		tokenType: String(payload.token_type ?? xai.tokenType ?? "Bearer"),
		baseUrl: getBaseUrl(),
	};
}

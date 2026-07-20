import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { login, resetJwksCacheForTests } from "./oauth.js";

const ISSUER = "https://auth.x.ai";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
const JWKS_URI = `${ISSUER}/.well-known/jwks.json`;
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

function b64url(obj: unknown): string {
	return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bufferToB64url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Real ES256 key pair + signer for the JWKS mock. Returns the public JWK
 * (for the JWKS response) and a function that signs an id_token carrying
 * the given nonce. The nonce is baked into the payload so the browser-flow
 * validateIdToken check (which requires a matching nonce when one was sent)
 * passes. */
async function makeSigner(): Promise<{ jwk: JsonWebKey; sign: (nonce: string) => Promise<string> }> {
	const pair = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	);
	const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
	const sign = async (nonce: string): Promise<string> => {
		const header = b64url({ alg: "ES256", kid: "k1" });
		const payload = b64url({
			iss: ISSUER,
			aud: CLIENT_ID,
			exp: Math.floor(Date.now() / 1000) + 3600,
			nonce,
		});
		const sig = await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
		pair.privateKey,
			new TextEncoder().encode(`${header}.${payload}`),
		);
		return `${header}.${payload}.${bufferToB64url(sig)}`;
	};
	return { jwk, sign };
}


/** Wire up the fetch mock: discovery doc (with required jwks_uri), JWKS, token
 * exchange. The id_token is generated lazily at token-exchange time so the
 * nonce can be read from the authorize URL the browser flow captured,
 * matching what a real AS does (echo the nonce from the authorize request). */
function mockFetch(jwk: JsonWebKey, sign: (nonce: string) => Promise<string>, getNonce: () => string | undefined) {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url === DISCOVERY_URL) {
			return new Response(
				JSON.stringify({
					issuer: ISSUER,
					authorization_endpoint: `${ISSUER}/oauth/authorize`,
					token_endpoint: TOKEN_ENDPOINT,
					jwks_uri: JWKS_URI,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url === JWKS_URI) {
			return new Response(
				JSON.stringify({ keys: [{ ...jwk, kid: "k1", alg: "ES256" }] }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url === TOKEN_ENDPOINT && init?.method === "POST") {
			const nonce = getNonce();
			const idToken = nonce ? await sign(nonce) : "";
			return new Response(
				JSON.stringify({
					access_token: "access-xyz",
					refresh_token: "refresh-xyz",
					id_token: idToken,
					expires_in: 3600,
					token_type: "Bearer",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
}

describe("login flow dispatch", () => {
	const realFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = realFetch;
		delete process.env.PI_XAI_LOGIN_METHOD;
	});

	it("dispatches to device code by default (no env var)", async () => {
		delete process.env.PI_XAI_LOGIN_METHOD;
		let hitDeviceEndpoint = false;
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("/.well-known/openid-configuration")) {
				return new Response(JSON.stringify({
					authorization_endpoint: "https://auth.x.ai/oauth/authorize",
					token_endpoint: "https://auth.x.ai/oauth/token",
					jwks_uri: "https://auth.x.ai/.well-known/jwks.json",
					id_token_signing_alg_values_supported: ["ES256"],
				}), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (url.includes("/oauth2/device/code")) {
				hitDeviceEndpoint = true;
				return new Response(JSON.stringify({
					device_code: "dc", user_code: "ABCD-EFGH",
					verification_uri: "https://accounts.x.ai/device",
					expires_in: 300, interval: 0,
				}), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			// Token poll: return pending forever; we only care that device code
			// was chosen, not that the flow completes.
			return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
		}) as typeof fetch;

		const promise = login({
			onAuth: () => {},
			onDeviceCode: () => {},
			onPrompt: async () => "",
			signal: AbortSignal.timeout(200),
		} as unknown as import("@earendil-works/pi-ai").OAuthLoginCallbacks);
		try { await promise; } catch { /* expected: abort or pending */ }
		expect(hitDeviceEndpoint).toBe(true);
	});

	it("dispatches to browser flow when PI_XAI_LOGIN_METHOD=callback", async () => {
		process.env.PI_XAI_LOGIN_METHOD = "callback";
		let hitAuthorize = false;
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.startsWith("http://127.0.0.1:")) {
				return realFetch(input);
			}
			if (url.includes("/oauth2/device/code")) {
				return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
			}
			// Discovery returns minimal doc; the authorize URL is constructed but
			// never fetched (browser opens it). Just flag that we got past the
			// device-code branch.
			hitAuthorize = true;
			return new Response(JSON.stringify({
				authorization_endpoint: "https://auth.x.ai/oauth/authorize",
				token_endpoint: "https://auth.x.ai/oauth/token",
				jwks_uri: "https://auth.x.ai/.well-known/jwks.json",
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		}) as typeof fetch;

		const promise = login({
			onAuth: () => {},
			onPrompt: async () => "",
			signal: AbortSignal.timeout(200),
		});
		try { await promise; } catch { /* expected: abort */ }
		expect(hitAuthorize).toBe(true);
	});
});

describe("login (callback server integration)", () => {
	const realFetch = globalThis.fetch;
	let signer: { jwk: JsonWebKey; sign: (nonce: string) => Promise<string> };
	// Captured authorize URL per test; the mock reads the nonce from it so the
	// id_token echoes the nonce the browser flow sent, matching a real AS.
	let authUrl: string;

	beforeEach(async () => {
		resetJwksCacheForTests();
		// Force the browser callback flow. The default is now device code, but
		// this suite exercises the loopback server path specifically.
		process.env.PI_XAI_LOGIN_METHOD = "callback";
		signer = await makeSigner();
		authUrl = "";
		const mocked = mockFetch(signer.jwk, signer.sign, () => {
			try { return new URL(authUrl).searchParams.get("nonce") ?? undefined; } catch { return undefined; }
		});
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			// The loopback callback hit must reach the real server, not the mock.
			if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
			return mocked(input, init);
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		resetJwksCacheForTests();
		vi.restoreAllMocks();
		delete process.env.PI_XAI_LOGIN_METHOD;
	});

	it("drives the loopback callback, exchanges the code, and returns credentials", async () => {
		const promise = login({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			signal: undefined,
		});

		// Wait for onAuth so the authorize URL (and the listening server) is ready.
		const deadline = Date.now() + 2000;
		while (!authUrl && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
		expect(authUrl).toBeTruthy();

		const url = new URL(authUrl);
		expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("nonce")).toBeTruthy();
		const state = url.searchParams.get("state")!;
		const redirectUri = url.searchParams.get("redirect_uri")!;

		// Hit the real loopback callback server with a matching code+state.
		const callbackUrl = new URL(redirectUri);
		callbackUrl.searchParams.set("code", "auth-code-123");
		callbackUrl.searchParams.set("state", state);
		const cbRes = await fetch(callbackUrl.toString());
		expect(cbRes.status).toBe(200);

		// Login exchanged the code (mocked) and returned credentials.
		const creds = await promise;
		expect(creds.access).toBe("access-xyz");
		expect(creds.refresh).toBe("refresh-xyz");
		expect(creds.idToken).toBeTruthy();
	});

	it("rejects on a state mismatch from the callback", async () => {
		const promise = login({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			signal: undefined,
		});
		// Attach the rejection handler up front so a fast reject never becomes
		// an unhandledRejection before the await below.
		const rejection = expect(promise).rejects.toThrow();

		const deadline = Date.now() + 2000;
		while (!authUrl && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
		expect(authUrl).toBeTruthy();

		const url = new URL(authUrl);
		const redirectUri = url.searchParams.get("redirect_uri")!;
		const callbackUrl = new URL(redirectUri);
		callbackUrl.searchParams.set("code", "auth-code-123");
		callbackUrl.searchParams.set("state", "wrong-state");
		await fetch(callbackUrl.toString());

		await rejection;
	});
});

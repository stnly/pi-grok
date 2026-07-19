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

/** Real ES256 id_token + matching public JWK for the JWKS mock. */
async function makeSignedIdToken(nonce?: string): Promise<{ token: string; jwk: JsonWebKey }> {
	const pair = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	);
	const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
	const header = b64url({ alg: "ES256", kid: "k1" });
	const payload = b64url({
		iss: ISSUER,
		aud: CLIENT_ID,
		exp: Math.floor(Date.now() / 1000) + 3600,
		...(nonce ? { nonce } : {}),
	});
	const sig = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		pair.privateKey,
		new TextEncoder().encode(`${header}.${payload}`),
	);
	return { token: `${header}.${payload}.${bufferToB64url(sig)}`, jwk };
}

interface AuthCapture {
	url: string;
}

/** Wire up the fetch mock: discovery doc (with required jwks_uri), JWKS, token exchange. */
function mockFetch(idToken: string, jwk: JsonWebKey) {
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

describe("login (callback server integration)", () => {
	const realFetch = globalThis.fetch;
	let signed: { token: string; jwk: JsonWebKey };

	beforeEach(async () => {
		resetJwksCacheForTests();
		// id_token has no nonce claim: validateIdToken only checks nonce when present.
		signed = await makeSignedIdToken();
		const mocked = mockFetch(signed.token, signed.jwk);
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
	});

	it("drives the loopback callback, exchanges the code, and returns credentials", async () => {
		const auth: AuthCapture = { url: "" };
		const promise = login({
			onAuth: (info) => {
				auth.url = info.url;
			},
			onPrompt: async () => "",
			signal: undefined,
		});

		// Wait for onAuth so the authorize URL (and the listening server) is ready.
		const deadline = Date.now() + 2000;
		while (!auth.url && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
		expect(auth.url).toBeTruthy();

		const authUrl = new URL(auth.url);
		expect(authUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
		expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
		const state = authUrl.searchParams.get("state")!;
		const redirectUri = authUrl.searchParams.get("redirect_uri")!;

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
		const auth: AuthCapture = { url: "" };
		const promise = login({
			onAuth: (info) => {
				auth.url = info.url;
			},
			onPrompt: async () => "",
			signal: undefined,
		});
		// Attach the rejection handler up front so a fast reject never becomes
		// an unhandledRejection before the await below.
		const rejection = expect(promise).rejects.toThrow();

		const deadline = Date.now() + 2000;
		while (!auth.url && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
		expect(auth.url).toBeTruthy();

		const authUrl = new URL(auth.url);
		const redirectUri = authUrl.searchParams.get("redirect_uri")!;
		const callbackUrl = new URL(redirectUri);
		callbackUrl.searchParams.set("code", "auth-code-123");
		callbackUrl.searchParams.set("state", "wrong-state");
		await fetch(callbackUrl.toString());

		await rejection;
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { login } from "./oauth.js";

const ISSUER = "https://auth.x.ai";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

function b64url(obj: unknown): string {
	return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Unsigned JWT (alg:none) valid for id_token checks: xAI issuer, our client
 * audience, future exp, no nonce (login generates its own nonce, and the
 * validator only checks nonce when the claim is present). */
function idToken(): string {
	return `${b64url({ alg: "none" })}.${b64url({
		iss: ISSUER,
		aud: CLIENT_ID,
		exp: Math.floor(Date.now() / 1000) + 3600,
	})}.sig`;
}

interface AuthCapture {
	url: string;
}

/** Wire up the fetch mock: discovery doc + token exchange. */
function mockFetch() {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url === DISCOVERY_URL) {
			return new Response(
				JSON.stringify({
					issuer: ISSUER,
					authorization_endpoint: `${ISSUER}/oauth/authorize`,
					token_endpoint: TOKEN_ENDPOINT,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url === TOKEN_ENDPOINT && init?.method === "POST") {
			return new Response(
				JSON.stringify({
					access_token: "access-xyz",
					refresh_token: "refresh-xyz",
					id_token: idToken(),
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

	beforeEach(() => {
		const mocked = mockFetch();
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			// The loopback callback hit must reach the real server, not the mock.
			if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
			return mocked(input, init);
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
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
		// an unhandled rejection.
		const expectation = expect(promise).rejects.toThrow(/state mismatch/i);

		// Wait for onAuth so the server is listening.
		const deadline = Date.now() + 2000;
		while (!auth.url && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));

		const redirectUri = new URL(auth.url).searchParams.get("redirect_uri")!;
		const callbackUrl = new URL(redirectUri);
		callbackUrl.searchParams.set("code", "auth-code-123");
		callbackUrl.searchParams.set("state", "wrong-state");
		await fetch(callbackUrl.toString());

		await expectation;
	});
});

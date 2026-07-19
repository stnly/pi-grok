import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { loginDeviceCode, resetJwksCacheForTests } from "./oauth.js";
import { XaiErrorCode } from "./errors.js";

const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const DEVICE_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const JWKS_URI = "https://auth.x.ai/.well-known/jwks.json";
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

/** Real ES256 id_token + matching JWKS entry for signature verification. */
async function makeSignedIdToken(): Promise<{ token: string; jwk: JsonWebKey }> {
	const pair = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	);
	const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
	const header = b64url({ alg: "ES256", kid: "k1" });
	const payload = b64url({
		iss: "https://auth.x.ai",
		aud: CLIENT_ID,
		exp: Math.floor(Date.now() / 1000) + 3600,
	});
	const sig = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		pair.privateKey,
		new TextEncoder().encode(`${header}.${payload}`),
	);
	return { token: `${header}.${payload}.${bufferToB64url(sig)}`, jwk };
}

interface DeviceState {
	pendingCount: number;
	tokenResponses: { status: number; body: unknown }[];
	jwk?: JsonWebKey;
}

/** Build a fetch mock: discovery (with required jwks_uri), JWKS, device-code,
 * then a queue of token-poll responses (consumed in order). */
function deviceFetch(state: DeviceState, codeResponse: unknown) {
	return vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		if (url === DISCOVERY_URL) {
			return new Response(JSON.stringify({
				authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
				token_endpoint: "https://auth.x.ai/oauth2/token",
				jwks_uri: JWKS_URI,
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		}
		if (url === JWKS_URI) {
			const keys = state.jwk ? [{ ...state.jwk, kid: "k1", alg: "ES256" }] : [];
			return new Response(JSON.stringify({ keys }), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
		}
		if (url === DEVICE_CODE_URL) {
			return new Response(JSON.stringify(codeResponse), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
		}
		if (url === DEVICE_TOKEN_URL) {
			const next = state.tokenResponses[state.pendingCount++];
			if (!next) throw new Error("no more token responses queued");
			return new Response(JSON.stringify(next.body), { status: next.status });
		}
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
}

function callbacks(signal?: AbortSignal): { cbs: OAuthLoginCallbacks; auth: { url: string | undefined; instructions: string | undefined } } {
	const auth = { url: undefined as string | undefined, instructions: undefined as string | undefined };
	const cbs: OAuthLoginCallbacks = {
		onAuth: (info) => { auth.url = info.url; auth.instructions = info.instructions; },
		onPrompt: async () => "",
		...(signal ? { signal } : {}),
	};
	return { cbs, auth };
}

describe("loginDeviceCode", () => {
	const realFetch = globalThis.fetch;

	beforeEach(() => {
		vi.restoreAllMocks();
		resetJwksCacheForTests();
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
		resetJwksCacheForTests();
	});

	it("surfaces the verification URI + user code, then exchanges after approval", async () => {
		const { token, jwk } = await makeSignedIdToken();
		const { cbs, auth } = callbacks();
		const state: DeviceState = {
			pendingCount: 0,
			jwk,
			tokenResponses: [
				{ status: 400, body: { error: "authorization_pending" } },
				{ status: 200, body: { access_token: "acc", refresh_token: "ref", id_token: token, expires_in: 3600 } },
			],
		};
		globalThis.fetch = deviceFetch(state, {
			device_code: "dc", user_code: "ABCD-EFGH",
			verification_uri: "https://accounts.x.ai/device",
			verification_uri_complete: "https://accounts.x.ai/device?user_code=ABCD-EFGH",
			expires_in: 300, interval: 0,
		});

		const creds = await loginDeviceCode(cbs);
		expect(auth.url).toBe("https://accounts.x.ai/device?user_code=ABCD-EFGH");
		expect(auth.instructions).toContain("ABCD-EFGH");
		expect(creds.access).toBe("acc");
		expect(creds.refresh).toBe("ref");
	}, 15_000);

	it("honors slow_down by continuing to poll", async () => {
		const { cbs } = callbacks();
		const state: DeviceState = { pendingCount: 0, tokenResponses: [
			{ status: 400, body: { error: "slow_down" } },
			// No id_token: device login still succeeds; signature path is skipped.
			{ status: 200, body: { access_token: "acc", refresh_token: "ref", expires_in: 3600 } },
		] };
		globalThis.fetch = deviceFetch(state, {
			device_code: "dc", user_code: "X",
			verification_uri: "https://accounts.x.ai/device", expires_in: 300, interval: 0,
		});
		const creds = await loginDeviceCode(cbs);
		expect(creds.access).toBe("acc");
	}, 15_000);

	it("throws a fatal DEVICE_CODE_FAILED on access_denied", async () => {
		const { cbs } = callbacks();
		const state: DeviceState = { pendingCount: 0, tokenResponses: [
			{ status: 400, body: { error: "access_denied" } },
		] };
		globalThis.fetch = deviceFetch(state, {
			device_code: "dc", user_code: "X",
			verification_uri: "https://accounts.x.ai/device", expires_in: 300, interval: 0,
		});
		await expect(loginDeviceCode(cbs)).rejects.toMatchObject({
			code: XaiErrorCode.DEVICE_CODE_FAILED, reloginRequired: true,
		});
	});

	it("throws a fatal DEVICE_CODE_FAILED on expired_token", async () => {
		const { cbs } = callbacks();
		const state: DeviceState = { pendingCount: 0, tokenResponses: [
			{ status: 400, body: { error: "expired_token" } },
		] };
		globalThis.fetch = deviceFetch(state, {
			device_code: "dc", user_code: "X",
			verification_uri: "https://accounts.x.ai/device", expires_in: 300, interval: 0,
		});
		await expect(loginDeviceCode(cbs)).rejects.toMatchObject({
			code: XaiErrorCode.DEVICE_CODE_FAILED, reloginRequired: true,
		});
	});

	it("rejects a token body that omits refresh_token", async () => {
		const { cbs } = callbacks();
		const state: DeviceState = { pendingCount: 0, tokenResponses: [
			{ status: 200, body: { access_token: "acc", expires_in: 3600 } },
		] };
		globalThis.fetch = deviceFetch(state, {
			device_code: "dc", user_code: "X",
			verification_uri: "https://accounts.x.ai/device", expires_in: 300, interval: 0,
		});
		await expect(loginDeviceCode(cbs)).rejects.toMatchObject({
			code: XaiErrorCode.DEVICE_CODE_FAILED, reloginRequired: true,
		});
	});

	it("rejects with cancel when the login is aborted mid-poll sleep", async () => {
		const ac = new AbortController();
		const { cbs, auth } = callbacks(ac.signal);
		// Pending response so the first poll does not resolve; interval 1s sleeps
		// long enough to abort during it.
		const state: DeviceState = { pendingCount: 0, tokenResponses: [
			{ status: 400, body: { error: "authorization_pending" } },
		] };
		globalThis.fetch = deviceFetch(state, {
			device_code: "dc", user_code: "X",
			verification_uri: "https://accounts.x.ai/device", expires_in: 300, interval: 1,
		});

		const promise = loginDeviceCode(cbs);
		// Wait for the code request + onAuth, then abort during the sleep.
		const deadline = Date.now() + 2000;
		while (!auth.url && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
		ac.abort();

		// The abort rejects the sleep with the cancel sentinel (Error, not a
		// fatal DEVICE_CODE_FAILED), so the user just sees a cancelled login.
		await expect(promise).rejects.toThrow(/cancelled/i);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { loginDeviceCode } from "./oauth.js";
import { XaiErrorCode } from "./errors.js";

const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const DEVICE_TOKEN_URL = "https://auth.x.ai/oauth2/token";

function b64url(obj: unknown): string {
	return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function idToken(): string {
	return `${b64url({ alg: "none" })}.${b64url({
		iss: "https://auth.x.ai",
		aud: "b1a00492-073a-47ea-816f-4c329264a828",
		exp: Math.floor(Date.now() / 1000) + 3600,
	})}.sig`;
}

interface DeviceState {
	pendingCount: number;
	tokenResponses: { status: number; body: unknown }[];
}

/** Build a fetch mock: one device-code response, then a queue of token-poll
 * responses (consumed in order). */
function deviceFetch(state: DeviceState, codeResponse: unknown) {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
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

function callbacks(): { cbs: OAuthLoginCallbacks; auth: { url: string | undefined; instructions: string | undefined } } {
	const auth = { url: undefined as string | undefined, instructions: undefined as string | undefined };
	const cbs: OAuthLoginCallbacks = {
		onAuth: (info) => { auth.url = info.url; auth.instructions = info.instructions; },
		onPrompt: async () => "",
	};
	return { cbs, auth };
}

describe("loginDeviceCode", () => {
	const realFetch = globalThis.fetch;

	beforeEach(() => { vi.restoreAllMocks(); });
	afterEach(() => { globalThis.fetch = realFetch; });

	it("surfaces the verification URI + user code, then exchanges after approval", async () => {
		const { cbs, auth } = callbacks();
		const state: DeviceState = { pendingCount: 0, tokenResponses: [
			{ status: 400, body: { error: "authorization_pending" } },
			{ status: 200, body: { access_token: "acc", refresh_token: "ref", id_token: idToken(), expires_in: 3600 } },
		] };
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
});

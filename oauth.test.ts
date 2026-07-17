import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type XaiOAuthCredentials,
	decodeIdToken,
	discover,
	getBaseUrl,
	isXaiOrigin,
	outcomeToError,
	parseCallbackPort,
	parseRedirectUrl,
	refresh,
	validateEndpoint,
	validateIdToken,
} from "./oauth.js";
import { XaiErrorCode, XaiOAuthError } from "./errors.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

/** Build an unsigned JWT with a given payload, base64url-encoded. */
function jwt(payload: Record<string, unknown>): string {
	const b64url = (obj: unknown) => {
		const json = JSON.stringify(obj);
		return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	};
	return `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
}

function fakeResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "Content-Type": "application/json" },
	});
}

// ─── parseCallbackPort ───────────────────────────────────────────────────────

describe("parseCallbackPort", () => {
	it("returns the default when undefined", () => {
		expect(parseCallbackPort(undefined)).toBe(56121);
	});

	it("parses a valid port", () => {
		expect(parseCallbackPort("8080")).toBe(8080);
	});

	it("rejects zero", () => {
		expect(parseCallbackPort("0")).toBe(56121);
	});

	it("rejects out-of-range high", () => {
		expect(parseCallbackPort("70000")).toBe(56121);
	});

	it("rejects non-numeric input", () => {
		expect(parseCallbackPort("not-a-port")).toBe(56121);
	});

	it("rejects negative numbers", () => {
		expect(parseCallbackPort("-1")).toBe(56121);
	});
});

// ─── parseRedirectUrl ────────────────────────────────────────────────────────

describe("parseRedirectUrl", () => {
	it("parses a full callback URL with code and state", () => {
		const r = parseRedirectUrl("http://127.0.0.1:56121/callback?code=AC&state=ST");
		expect(r).toEqual({ code: "AC", state: "ST" });
	});

	it("parses a bare querystring", () => {
		const r = parseRedirectUrl("code=AC&state=ST");
		expect(r).toEqual({ code: "AC", state: "ST" });
	});

	it("treats a bare code as the code with no state", () => {
		const r = parseRedirectUrl("AC123");
		expect(r).toEqual({ code: "AC123" });
	});

	it("returns empty for blank input", () => {
		expect(parseRedirectUrl("   ")).toEqual({});
	});

	it("returns undefined fields when params are absent", () => {
		const r = parseRedirectUrl("http://127.0.0.1:56121/callback");
		expect(r).toEqual({ code: undefined, state: undefined });
	});
});

// ─── isXaiOrigin / validateEndpoint ──────────────────────────────────────────

describe("isXaiOrigin", () => {
	it("accepts https://x.ai", () => {
		expect(isXaiOrigin(new URL("https://x.ai"))).toBe(true);
	});

	it("accepts https subdomains of x.ai", () => {
		expect(isXaiOrigin(new URL("https://auth.x.ai"))).toBe(true);
		expect(isXaiOrigin(new URL("https://accounts.x.ai"))).toBe(true);
	});

	it("rejects http (non-https)", () => {
		expect(isXaiOrigin(new URL("http://x.ai"))).toBe(false);
	});

	it("rejects non-xAI hosts", () => {
		expect(isXaiOrigin(new URL("https://evil.com"))).toBe(false);
		expect(isXaiOrigin(new URL("https://x.ai.evil.com"))).toBe(false);
	});
});

describe("validateEndpoint", () => {
	it("returns the URL string for a valid xAI https endpoint", () => {
		expect(validateEndpoint("https://auth.x.ai/oauth/token", "token_endpoint"))
			.toBe("https://auth.x.ai/oauth/token");
	});

	it("throws DISCOVERY_INVALID_ORIGIN for a non-xAI host", () => {
		expect(() => validateEndpoint("https://evil.com/token", "token_endpoint")).toThrow(XaiOAuthError);
		try {
			validateEndpoint("https://evil.com/token", "token_endpoint");
		} catch (e) {
			expect((e as XaiOAuthError).code).toBe(XaiErrorCode.DISCOVERY_INVALID_ORIGIN);
		}
	});

	it("throws for an unparseable value", () => {
		expect(() => validateEndpoint("not a url", "token_endpoint")).toThrow(XaiOAuthError);
	});

	it("throws for http", () => {
		expect(() => validateEndpoint("http://x.ai/token", "token_endpoint")).toThrow(XaiOAuthError);
	});
});

// ─── decodeIdToken / validateIdToken ─────────────────────────────────────────

describe("decodeIdToken", () => {
	it("decodes a well-formed JWT payload", () => {
		const claims = decodeIdToken(jwt({ iss: "https://auth.x.ai", aud: CLIENT_ID, sub: "u1" }));
		expect(claims?.iss).toBe("https://auth.x.ai");
		expect(claims?.aud).toBe(CLIENT_ID);
	});

	it("returns null for a two-part string", () => {
		expect(decodeIdToken("a.b")).toBeNull();
	});

	it("returns null for garbage", () => {
		expect(decodeIdToken("garbage")).toBeNull();
	});
});

describe("validateIdToken", () => {
	it("accepts a valid token with matching nonce", () => {
		expect(() =>
			validateIdToken(jwt({ iss: "https://auth.x.ai", aud: CLIENT_ID, nonce: "N1" }), "N1"),
		).not.toThrow();
	});

	it("accepts an array audience containing our client_id", () => {
		expect(() =>
			validateIdToken(jwt({ iss: "https://auth.x.ai", aud: ["other", CLIENT_ID] }), "N1"),
		).not.toThrow();
	});

	it("throws on a non-xAI issuer", () => {
		expect(() =>
			validateIdToken(jwt({ iss: "https://evil.com", aud: CLIENT_ID }), "N1"),
		).toThrow(XaiOAuthError);
	});

	it("throws on audience mismatch", () => {
		try {
			validateIdToken(jwt({ iss: "https://auth.x.ai", aud: "someone-else" }), "N1");
			throw new Error("should have thrown");
		} catch (e) {
			expect((e as XaiOAuthError).code).toBe(XaiErrorCode.ID_TOKEN_INVALID);
		}
	});

	it("throws on nonce mismatch", () => {
		expect(() =>
			validateIdToken(jwt({ iss: "https://auth.x.ai", aud: CLIENT_ID, nonce: "wrong" }), "N1"),
		).toThrow(XaiOAuthError);
	});

	it("skips the nonce check when the claim is absent", () => {
		expect(() =>
			validateIdToken(jwt({ iss: "https://auth.x.ai", aud: CLIENT_ID }), "N1"),
		).not.toThrow();
	});

	it("throws on an expired exp (outside clock skew)", () => {
		const expired = Math.floor(Date.now() / 1000) - 100;
		expect(() =>
			validateIdToken(jwt({ iss: "https://auth.x.ai", aud: CLIENT_ID, exp: expired }), "N1"),
		).toThrow(XaiOAuthError);
	});

	it("accepts an exp within clock skew", () => {
		const almost = Math.floor(Date.now() / 1000) - 5;
		expect(() =>
			validateIdToken(jwt({ iss: "https://auth.x.ai", aud: CLIENT_ID, exp: almost }), "N1"),
		).not.toThrow();
	});
});

// ─── outcomeToError ──────────────────────────────────────────────────────────

describe("outcomeToError", () => {
	it("converts cancelled to the sentinel Error pi's dialog swallows", () => {
		const err = outcomeToError({ kind: "cancelled" });
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe("Login cancelled");
	});

	it("converts error to a typed XaiOAuthError", () => {
		const err = outcomeToError({ kind: "error", message: "boom" });
		expect(err).toBeInstanceOf(XaiOAuthError);
		expect((err as XaiOAuthError).code).toBe(XaiErrorCode.AUTHORIZATION_FAILED);
		expect(err.message).toBe("boom");
	});
});

// ─── getBaseUrl ──────────────────────────────────────────────────────────────

	describe("getBaseUrl", () => {
	const orig = { a: process.env.PI_XAI_BASE_URL, b: process.env.XAI_BASE_URL };
	afterEach(() => {
		// Restore to the value held before this suite ran. Assigning undefined
		// to process.env stringifies to "undefined" rather than deleting, so an
		// originally-absent var must be deleted explicitly (otherwise it leaks
		// as a truthy "undefined" string into sibling suites).
		if (orig.a === undefined) delete process.env.PI_XAI_BASE_URL;
		else process.env.PI_XAI_BASE_URL = orig.a;
		if (orig.b === undefined) delete process.env.XAI_BASE_URL;
		else process.env.XAI_BASE_URL = orig.b;
	});

	it("defaults to the public xAI API", () => {
		expect(getBaseUrl()).toBe("https://api.x.ai/v1");
	});

	it("prefers PI_XAI_BASE_URL", () => {
		process.env.PI_XAI_BASE_URL = "https://custom.example/v1/";
		expect(getBaseUrl()).toBe("https://custom.example/v1");
	});

	it("trims trailing slashes", () => {
		process.env.PI_XAI_BASE_URL = "https://custom.example/v1///";
		expect(getBaseUrl()).toBe("https://custom.example/v1");
	});

	it("falls back to XAI_BASE_URL", () => {
		process.env.XAI_BASE_URL = "https://fb.example/v1";
		expect(getBaseUrl()).toBe("https://fb.example/v1");
	});
});

// ─── discover (mocked fetch) ─────────────────────────────────────────────────

describe("discover", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.restoreAllMocks();
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns validated endpoints from the OIDC config", async () => {
		globalThis.fetch = vi.fn(async () =>
			fakeResponse({
				authorization_endpoint: "https://auth.x.ai/oauth/authorize",
				token_endpoint: "https://auth.x.ai/oauth/token",
			}),
		) as typeof fetch;

		const d = await discover();
		expect(d.authorization_endpoint).toBe("https://auth.x.ai/oauth/authorize");
		expect(d.token_endpoint).toBe("https://auth.x.ai/oauth/token");
	});

	it("throws DISCOVERY_FAILED on a non-ok response", async () => {
		globalThis.fetch = vi.fn(async () => new Response("nope", { status: 503 })) as typeof fetch;
		await expect(discover()).rejects.toMatchObject({ code: XaiErrorCode.DISCOVERY_FAILED });
	});

	it("throws DISCOVERY_INVALID_ORIGIN when an endpoint is off-origin", async () => {
		globalThis.fetch = vi.fn(async () =>
			fakeResponse({
				authorization_endpoint: "https://evil.com/auth",
				token_endpoint: "https://auth.x.ai/oauth/token",
			}),
		) as typeof fetch;
		await expect(discover()).rejects.toMatchObject({
			code: XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
		});
	});

	it("throws DISCOVERY_FAILED on a network error", async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error("network down");
		}) as typeof fetch;
		await expect(discover()).rejects.toMatchObject({ code: XaiErrorCode.DISCOVERY_FAILED });
	});
});

// ─── refresh (mocked fetch) ──────────────────────────────────────────────────

describe("refresh", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.restoreAllMocks();
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function creds(over: Partial<XaiOAuthCredentials> = {}): XaiOAuthCredentials {
		return {
			access: "old-access",
			refresh: "old-refresh",
			expires: Date.now() + 1000,
			tokenEndpoint: "https://auth.x.ai/oauth/token",
			...over,
		} as XaiOAuthCredentials;
	}

	it("exchanges a refresh_token for a new access token", async () => {
		globalThis.fetch = vi.fn(async () =>
			fakeResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
		) as typeof fetch;

		const out = (await refresh(creds())) as XaiOAuthCredentials;
		expect(out.access).toBe("new-access");
		expect(out.refresh).toBe("new-refresh");
		expect(out.tokenEndpoint).toBe("https://auth.x.ai/oauth/token");
		// expires_in maps to a future timestamp (minus skew).
		expect(out.expires).toBeGreaterThan(Date.now());

		// Wire contract: POST to the token endpoint with the refresh grant.
		const call = (globalThis.fetch as any).mock.calls.find(
			(c: unknown[]) => String(c[0]).endsWith("/oauth/token"),
		);
		expect(call).toBeDefined();
		expect(call[1].method).toBe("POST");
		const body = String(call[1].body);
		expect(body).toContain("grant_type=refresh_token");
		expect(body).toContain("refresh_token=old-refresh");
	});

	it("reuses the old refresh_token when the response omits one", async () => {
		globalThis.fetch = vi.fn(async () =>
			fakeResponse({ access_token: "new-access", expires_in: 3600 }),
		) as typeof fetch;

		const out = (await refresh(creds({ refresh: "keep-me" }))) as XaiOAuthCredentials;
		expect(out.refresh).toBe("keep-me");
	});

	it("marks 400/401/403 as fatal (reloginRequired)", async () => {
		for (const status of [400, 401, 403]) {
			globalThis.fetch = vi.fn(async () => new Response("bad", { status })) as typeof fetch;
			try {
				await refresh(creds());
				throw new Error(`status ${status} should have thrown`);
			} catch (e) {
				expect((e as XaiOAuthError).code).toBe(XaiErrorCode.REFRESH_FAILED);
				expect((e as XaiOAuthError).reloginRequired).toBe(true);
			}
		}
	});

	it("treats a 500 as retryable (not fatal)", async () => {
		globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch;
		try {
			await refresh(creds());
			throw new Error("should have thrown");
		} catch (e) {
			expect((e as XaiOAuthError).reloginRequired).toBe(false);
		}
	});

	it("throws REFRESH_FAILED when the response has no access_token", async () => {
		globalThis.fetch = vi.fn(async () => fakeResponse({})) as typeof fetch;
		try {
			await refresh(creds());
			throw new Error("should have thrown");
		} catch (e) {
			expect((e as XaiOAuthError).code).toBe(XaiErrorCode.REFRESH_FAILED);
			expect((e as XaiOAuthError).reloginRequired).toBe(true);
		}
	});

	it("throws REFRESH_MISSING when there is no refresh_token", async () => {
		globalThis.fetch = vi.fn(async () => fakeResponse({ access_token: "x" })) as typeof fetch;
		await expect(refresh(creds({ refresh: "" }))).rejects.toMatchObject({
			code: XaiErrorCode.REFRESH_MISSING,
		});
	});

	it("discovers the token endpoint when neither credentials nor discovery carry it", async () => {
		let discoverCalled = false;
		globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
			const u = String(url);
			if (u.endsWith("/.well-known/openid-configuration")) {
				discoverCalled = true;
				return fakeResponse({
					authorization_endpoint: "https://auth.x.ai/oauth/authorize",
					token_endpoint: "https://auth.x.ai/oauth/token",
				});
			}
			return fakeResponse({ access_token: "new", expires_in: 3600 });
		}) as typeof fetch;

		await refresh(creds({ tokenEndpoint: undefined, discovery: undefined }));
		expect(discoverCalled).toBe(true);
	});
});

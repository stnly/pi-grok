import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PRIVACY_ALIASES,
	fetchUser,
	formatStatusBlock,
	parsePrivacyArg,
	privacyChoices,
	privacyLine,
	privacyUsage,
	setCodingDataRetention,
} from "./account.js";
import type { XaiUser } from "./account.js";
import { XaiErrorCode, XaiOAuthError } from "./errors.js";
import { CLI_PROXY_BASE_URL, CLI_PROXY_HEADERS } from "./models.js";

// ─── parsePrivacyArg ─────────────────────────────────────────────────────────

describe("parsePrivacyArg", () => {
	it("returns select for empty input (no argument required)", () => {
		expect(parsePrivacyArg("")).toEqual({ kind: "select" });
	});

	it("returns select for whitespace-only input", () => {
		expect(parsePrivacyArg("   ")).toEqual({ kind: "select" });
	});

	it("maps opt-out aliases to optOut=true (privacy mode)", () => {
		for (const a of ["opt-out", "out", "private"]) {
			expect(parsePrivacyArg(a)).toEqual({ kind: "set", optOut: true });
		}
	});

	it("maps opt-in aliases to optOut=false (share data)", () => {
		for (const a of ["opt-in", "in", "share"]) {
			expect(parsePrivacyArg(a)).toEqual({ kind: "set", optOut: false });
		}
	});

	it("is case-insensitive and trims surrounding whitespace", () => {
		expect(parsePrivacyArg("  Opt-Out  ")).toEqual({ kind: "set", optOut: true });
		expect(parsePrivacyArg("IN")).toEqual({ kind: "set", optOut: false });
		expect(parsePrivacyArg("\tshare\n")).toEqual({ kind: "set", optOut: false });
	});

	it("rejects unknown arguments", () => {
		expect(parsePrivacyArg("optout")).toEqual({ kind: "invalid", arg: "optout" });
		expect(parsePrivacyArg("--opt-in")).toEqual({ kind: "invalid", arg: "--opt-in" });
	});

	it("keeps every alias resolvable (no alias is left invalid)", () => {
		for (const key of Object.keys(PRIVACY_ALIASES)) {
			expect(parsePrivacyArg(key)).toHaveProperty("kind", "set");
		}
	});
});

// ─── privacyUsage ────────────────────────────────────────────────────────────

describe("privacyUsage", () => {
	it("lists both opt-in and opt-out groups", () => {
		const text = privacyUsage();
		expect(text).toContain("opt-in");
		expect(text).toContain("opt-out");
	});

	it("names every alias somewhere in the line", () => {
		const text = privacyUsage();
		for (const key of Object.keys(PRIVACY_ALIASES)) {
			expect(text).toContain(key);
		}
	});
});

// ─── privacyChoices ───────────────────────────────────────────────────────

describe("privacyChoices", () => {
	it("offers two rows in a stable order", () => {
		const choices = privacyChoices(true);
		expect(choices).toHaveLength(2);
		expect(choices.map((c) => c.optOut)).toEqual([true, false]);
	});

	it("marks the opted-out row as current when the account is opted out", () => {
		const choices = privacyChoices(true);
		expect(choices[0].current).toBe(true);
		expect(choices[1].current).toBe(false);
	});

	it("marks the share-data row as current when the account is opted in", () => {
		const choices = privacyChoices(false);
		expect(choices[0].current).toBe(false);
		expect(choices[1].current).toBe(true);
	});
});

// ─── privacyLine ────────────────────────────────────────────────────────

describe("privacyLine", () => {
	it("reports the ZDR lock when isZdr is set, regardless of opt-out flag", () => {
		const locked = privacyLine({ codingDataRetentionOptOut: false, isZdr: true });
		expect(locked).toMatch(/Zero Data Retention/i);
		expect(locked.toLowerCase()).toContain("locked");
		// Even an opted-out account shows the lock, since the flag is moot.
		expect(privacyLine({ codingDataRetentionOptOut: true, isZdr: true })).toBe(locked);
	});

	it("labels privacy mode when opted out", () => {
		expect(privacyLine({ codingDataRetentionOptOut: true })).toContain("privacy mode");
	});

	it("labels share data when opted in", () => {
		expect(privacyLine({ codingDataRetentionOptOut: false })).toContain("share data");
	});
});

// ─── formatStatusBlock ───────────────────────────────────────────────────────

function fakeUser(over: Partial<XaiUser> = {}): XaiUser {
	return {
		userId: "u1",
		email: "hi@example.com",
		firstName: "Alice",
		lastName: null,
		profileImageAssetId: null,
		userBlockedReason: null,
		principalType: "User",
		principalId: "u1",
		teamId: null,
		teamName: null,
		teamRole: null,
		teamBlockedReasons: [],
		organizationId: null,
		organizationName: null,
		organizationRole: null,
		codingDataRetentionOptOut: true,
		hasGrokCodeAccess: true,
		...over,
	};
}

describe("formatStatusBlock", () => {
	it("shows model count, account, code access, and privacy for an oauth user", () => {
		const block = formatStatusBlock({ user: fakeUser(), modelCount: 7, tokenSource: "oauth" });
		expect(block).toContain("Models: 7 available");
		expect(block).toContain("Account: Alice <hi@example.com>");
		expect(block).toContain("Code access: yes");
		expect(block).toContain("Privacy: privacy mode");
	});

	it("includes team and org lines when present", () => {
		const block = formatStatusBlock({
			user: fakeUser({ teamName: "Acme", organizationName: "Acme Org" }),
			modelCount: 3,
			tokenSource: "oauth",
		});
		expect(block).toContain("Team: Acme");
		expect(block).toContain("Org: Acme Org");
	});

	it("falls back to email when no display name is set", () => {
		const block = formatStatusBlock({
			user: fakeUser({ firstName: null, lastName: null }),
			modelCount: 1,
			tokenSource: "oauth",
		});
		expect(block).toContain("Account: hi@example.com");
	});

	it("flags the env bypass token source", () => {
		const block = formatStatusBlock({ user: null, modelCount: 0, tokenSource: "env" });
		expect(block).toContain("env bypass");
	});

	it("returns a login prompt and nothing else when not logged in", () => {
		const block = formatStatusBlock({ user: null, modelCount: 0, tokenSource: "none" });
		expect(block).toContain("not logged in");
		expect(block).not.toContain("Models:");
	});

	it("still renders models when the /user fetch failed (user is null)", () => {
		const block = formatStatusBlock({ user: null, modelCount: 5, tokenSource: "oauth" });
		expect(block).toContain("Models: 5 available");
		expect(block).not.toContain("Account:");
	});
});

// ─── Proxy network calls (mocked fetch) ──────────────────────────────────────

describe("fetchUser", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.restoreAllMocks();
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function okUser(over: Partial<XaiUser> = {}): XaiUser {
		return {
			userId: "u1",
			email: "a@b.com",
			firstName: null,
			lastName: null,
			profileImageAssetId: null,
			userBlockedReason: null,
			principalType: null,
			principalId: null,
			teamId: null,
			teamName: null,
			teamRole: null,
			teamBlockedReasons: null,
			organizationId: null,
			organizationName: null,
			organizationRole: null,
			codingDataRetentionOptOut: false,
			hasGrokCodeAccess: true,
			...over,
		};
	}

	it("returns the parsed user on 200", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify(okUser({ email: "x@y.com" })), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		) as typeof fetch;
		const user = await fetchUser("tok");
		expect(user.email).toBe("x@y.com");

		// Wire contract: GET /user with the bearer and the proxy identity headers.
		expect(globalThis.fetch).toHaveBeenCalledWith(
			`${CLI_PROXY_BASE_URL}/user`,
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer tok",
					"X-XAI-Token-Auth": CLI_PROXY_HEADERS["X-XAI-Token-Auth"],
				}),
			}),
		);
	});

	it("marks 401 as fatal (reloginRequired)", async () => {
		globalThis.fetch = vi.fn(async () => new Response("unauth", { status: 401 })) as typeof fetch;
		try {
			await fetchUser("tok");
			throw new Error("should have thrown");
		} catch (e) {
			expect((e as XaiOAuthError).code).toBe(XaiErrorCode.PROXY_REQUEST_FAILED);
			expect((e as XaiOAuthError).reloginRequired).toBe(true);
		}
	});

	it("wraps a non-ok, non-401 response as PROXY_REQUEST_FAILED", async () => {
		globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch;
		try {
			await fetchUser("tok");
			throw new Error("should have thrown");
		} catch (e) {
			expect((e as XaiOAuthError).code).toBe(XaiErrorCode.PROXY_REQUEST_FAILED);
			expect((e as XaiOAuthError).reloginRequired).toBe(false);
			expect((e as XaiOAuthError).message).toContain("500");
		}
	});

	it("wraps a network failure as PROXY_REQUEST_FAILED", async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error("offline");
		}) as typeof fetch;
		await expect(fetchUser("tok")).rejects.toMatchObject({
			code: XaiErrorCode.PROXY_REQUEST_FAILED,
		});
	});
});

describe("setCodingDataRetention", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.restoreAllMocks();
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns the echoed server state on 200", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ codingDataRetentionOptOut: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		) as typeof fetch;
		// Requested true; server echoes true.
		await expect(setCodingDataRetention("tok", true)).resolves.toBe(true);

		// Wire contract: PUT /privacy/coding-data-retention with json + proxy headers.
		expect(globalThis.fetch).toHaveBeenCalledWith(
			`${CLI_PROXY_BASE_URL}/privacy/coding-data-retention`,
			expect.objectContaining({
				method: "PUT",
				headers: expect.objectContaining({
					Authorization: "Bearer tok",
					"Content-Type": "application/json",
					"X-XAI-Token-Auth": CLI_PROXY_HEADERS["X-XAI-Token-Auth"],
				}),
			}),
		);
	});

	it("falls back to the requested value when the echo is absent", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		) as typeof fetch;
		await expect(setCodingDataRetention("tok", false)).resolves.toBe(false);
	});

	it("marks 401 as fatal", async () => {
		globalThis.fetch = vi.fn(async () => new Response("unauth", { status: 401 })) as typeof fetch;
		try {
			await setCodingDataRetention("tok", true);
			throw new Error("should have thrown");
		} catch (e) {
			expect((e as XaiOAuthError).reloginRequired).toBe(true);
		}
	});

	it("wraps a 500 as PROXY_REQUEST_FAILED (not fatal)", async () => {
		globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch;
		try {
			await setCodingDataRetention("tok", true);
			throw new Error("should have thrown");
		} catch (e) {
			expect((e as XaiOAuthError).code).toBe(XaiErrorCode.PROXY_REQUEST_FAILED);
			expect((e as XaiOAuthError).reloginRequired).toBe(false);
		}
	});
});

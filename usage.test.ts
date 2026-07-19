import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	XaiUsageError,
	fetchUsage,
	formatUsageBlock,
	parseUsageBody,
	parseUserId,
	type XaiUsageSnapshot,
} from "./usage.js";
import { CLI_PROXY_BASE_URL } from "./models.js";

// ─── parseUsageBody ─────────────────────────────────────────────────────────

describe("parseUsageBody", () => {
	it("throws on a body that is not an object", () => {
		expect(() => parseUsageBody("noise")).toThrow(XaiUsageError);
		expect(() => parseUsageBody([1, 2, 3])).toThrow(XaiUsageError);
		expect(() => parseUsageBody(null)).toThrow(XaiUsageError);
	});

	it("throws when config is present but not an object", () => {
		expect(() => parseUsageBody({ config: "broken" })).toThrow(XaiUsageError);
		expect(() => parseUsageBody({ config: [1, 2] })).toThrow(XaiUsageError);
	});

	it("throws when history is present but not an array", () => {
		expect(() => parseUsageBody({ config: { history: "not-array" } })).toThrow(XaiUsageError);
	});

	it("throws when history exceeds the cap", () => {
		const periods = Array.from({ length: 50 }, (_, i) => ({ totalUsed: { val: i } }));
		expect(() => parseUsageBody({ config: { history: periods } })).toThrow(XaiUsageError);
	});

	it("returns a sparse snapshot for a body with only a tier label", () => {
		const snap = parseUsageBody({ subscriptionTier: "Epic" });
		expect(snap.subscriptionTier).toBe("Epic");
		expect(snap.history).toEqual([]);
		expect(snap.creditUsagePercent).toBeUndefined();
	});

	it("extracts the percent from config.creditUsagePercent", () => {
		const snap = parseUsageBody({ config: { creditUsagePercent: 42 } });
		expect(snap.creditUsagePercent).toBe(42);
	});

	it("clamps a percentage above 100", () => {
		const snap = parseUsageBody({ config: { creditUsagePercent: 250 } });
		expect(snap.creditUsagePercent).toBe(100);
	});

	it("clamps a negative percentage to 0", () => {
		const snap = parseUsageBody({ config: { creditUsagePercent: -10 } });
		expect(snap.creditUsagePercent).toBe(0);
	});

	it("rejects a non-numeric percent", () => {
		const snap = parseUsageBody({ config: { creditUsagePercent: "lots" } });
		expect(snap.creditUsagePercent).toBeUndefined();
	});

	it("extracts used and monthly limit from {val: cents} wrappers", () => {
		const snap = parseUsageBody({
			config: { used: { val: 12_000 }, monthlyLimit: { val: 50_000 } },
		});
		expect(snap.usedCents).toBe(12_000);
		expect(snap.monthlyLimitCents).toBe(50_000);
	});

	it("rejects a cents wrapper with a missing val", () => {
		const snap = parseUsageBody({ config: { used: {} } });
		expect(snap.usedCents).toBeUndefined();
	});

	it("rejects a cents wrapper that carries a non-numeric val", () => {
		const snap = parseUsageBody({ config: { used: { val: "lots" } } });
		expect(snap.usedCents).toBeUndefined();
	});

	it("rejects a bare numeric value where a cents wrapper is expected", () => {
		const snap = parseUsageBody({ config: { used: 12_000 } });
		expect(snap.usedCents).toBeUndefined();
	});

	it("extracts on-demand and prepaid fields", () => {
		const snap = parseUsageBody({
			config: {
				onDemandCap: { val: 100_000 },
				onDemandUsed: { val: 5_000 },
				prepaidBalance: { val: 2_000 },
			},
		});
		expect(snap.onDemandCapCents).toBe(100_000);
		expect(snap.onDemandUsedCents).toBe(5_000);
		expect(snap.prepaidBalanceCents).toBe(2_000);
	});

	it("carries the top-level onDemandEnabled flag", () => {
		const snap = parseUsageBody({ onDemandEnabled: true });
		expect(snap.onDemandEnabled).toBe(true);
	});

	it("carries the config.isUnifiedBillingUser flag", () => {
		const snap = parseUsageBody({ config: { isUnifiedBillingUser: true } });
		expect(snap.isUnifiedBillingUser).toBe(true);
	});

	it("parses the per-product usage breakdown", () => {
		const snap = parseUsageBody({
			config: {
				productUsage: [
					{ product: "GrokBuild", usagePercent: 2 },
					{ product: "GrokApp", usagePercent: 0 },
				],
			},
		});
		expect(snap.productUsage).toEqual([
			{ product: "GrokBuild", usagePercent: 2 },
			{ product: "GrokApp", usagePercent: 0 },
		]);
	});

	it("drops productUsage entries with a missing or non-numeric percent", () => {
		const snap = parseUsageBody({
			config: {
				productUsage: [
					{ product: "GrokBuild", usagePercent: 2 },
					{ product: "GrokApp" },
					{ product: 42, usagePercent: 1 },
				],
			},
		});
		expect(snap.productUsage).toEqual([{ product: "GrokBuild", usagePercent: 2 }]);
	});

	it("parses a structured currentPeriod", () => {
		const snap = parseUsageBody({
			config: { currentPeriod: { type: "monthly", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" } },
		});
		expect(snap.currentPeriod?.type).toBe("monthly");
		expect(snap.currentPeriod?.start).toBe("2026-01-01T00:00:00Z");
		expect(snap.currentPeriod?.end).toBe("2026-02-01T00:00:00Z");
	});

	it("falls back to billingPeriodStart/End when currentPeriod is absent", () => {
		const snap = parseUsageBody({
			config: { billingPeriodStart: "2026-01-01T00:00:00Z", billingPeriodEnd: "2026-02-01T00:00:00Z" },
		});
		expect(snap.currentPeriod?.start).toBe("2026-01-01T00:00:00Z");
		expect(snap.currentPeriod?.end).toBe("2026-02-01T00:00:00Z");
	});

	it("rejects a malformed timestamp", () => {
		const snap = parseUsageBody({ config: { currentPeriod: { start: "yesterday" } } });
		expect(snap.currentPeriod).toBeUndefined();
	});

	it("parses history entries with period, billing cycle, and cents wrappers", () => {
		const snap = parseUsageBody({
			config: {
				history: [
					{
						period: { type: "monthly", start: "2025-12-01T00:00:00Z", end: "2026-01-01T00:00:00Z" },
						billingCycle: { year: 2025, month: 12 },
						includedUsed: { val: 4_000 },
						onDemandUsed: { val: 1_000 },
						totalUsed: { val: 5_000 },
					},
				],
			},
		});
		expect(snap.history).toHaveLength(1);
		expect(snap.history[0]?.period?.start).toBe("2025-12-01T00:00:00Z");
		expect(snap.history[0]?.billingCycle).toEqual({ year: 2025, month: 12 });
		expect(snap.history[0]?.includedUsedCents).toBe(4_000);
		expect(snap.history[0]?.onDemandUsedCents).toBe(1_000);
		expect(snap.history[0]?.totalUsedCents).toBe(5_000);
	});

	it("rejects a billing cycle with an out-of-range month", () => {
		const snap = parseUsageBody({
			config: { history: [{ billingCycle: { year: 2025, month: 13 } }] },
		});
		expect(snap.history[0]?.billingCycle).toBeUndefined();
	});

	it("rejects a tier label longer than the bound", () => {
		const long = "x".repeat(200);
		const snap = parseUsageBody({ subscriptionTier: long });
		expect(snap.subscriptionTier).toBeUndefined();
	});
});

// ─── parseUserId ────────────────────────────────────────────────────────────

describe("parseUserId", () => {
	it("returns the user id for a printable-ASCII string", () => {
		expect(parseUserId({ userId: "user-123" })).toBe("user-123");
	});

	it("throws when userId is missing", () => {
		expect(() => parseUserId({})).toThrow(XaiUsageError);
	});

	it("throws when userId is not a string", () => {
		expect(() => parseUserId({ userId: 42 })).toThrow(XaiUsageError);
	});

	it("throws when userId contains whitespace", () => {
		expect(() => parseUserId({ userId: "user 123" })).toThrow(XaiUsageError);
	});

	it("throws when userId contains control characters", () => {
		expect(() => parseUserId({ userId: "user\t123" })).toThrow(XaiUsageError);
		expect(() => parseUserId({ userId: "user\n123" })).toThrow(XaiUsageError);
	});

	it("throws when userId exceeds the length cap", () => {
		expect(() => parseUserId({ userId: "x".repeat(300) })).toThrow(XaiUsageError);
	});

	it("throws when the body is not an object", () => {
		expect(() => parseUserId("noise")).toThrow(XaiUsageError);
		expect(() => parseUserId(null)).toThrow(XaiUsageError);
	});
});

// ─── formatUsageBlock ───────────────────────────────────────────────────────

describe("formatUsageBlock", () => {
	it("always opens with the unofficial header line", () => {
		const block = formatUsageBlock({ history: [] });
		expect(block).toContain("xAI usage (unofficial, revision-pinned):");
	});

	it("renders the headline percent as 0% when no usage source was returned", () => {
		// A fresh period with no traffic has no creditUsagePercent and no
		// used/monthlyLimit. Surface 0% instead of dropping the line, so the
		// command output always has the headline number.
		const block = formatUsageBlock({ history: [] });
		expect(block).toContain("Included usage: 0%");
	});

	it("renders the period type as a label when present", () => {
		const block = formatUsageBlock({
			history: [],
			currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
		});
		expect(block).toContain("Weekly usage:");
	});

	it("renders the product breakdown when productUsage is present", () => {
		const block = formatUsageBlock({
			history: [],
			productUsage: [
				{ product: "GrokBuild", usagePercent: 2 },
				{ product: "GrokApp", usagePercent: 0 },
			],
		});
		expect(block).toContain("GrokBuild: 2%");
		expect(block).toContain("GrokApp: 0%");
	});

	it("renders the tier with the Subscription label", () => {
		const block = formatUsageBlock({ history: [], subscriptionTier: "Epic" });
		expect(block).toContain("Subscription: Epic");
	});

	it("renders the credit usage percent", () => {
		const block = formatUsageBlock({ history: [], creditUsagePercent: 42 });
		expect(block).toContain("Included usage: 42%");
	});

	it("derives the percent from used/limit when creditUsagePercent is absent", () => {
		const block = formatUsageBlock({
			history: [],
			usedCents: 12_500,
			monthlyLimitCents: 50_000,
		});
		// 12500 / 50000 = 25%
		expect(block).toContain("Included usage: 25%");
	});

	it("renders used and limit with two-decimal cents", () => {
		const block = formatUsageBlock({
			history: [],
			usedCents: 12_550,
			monthlyLimitCents: 50_000,
		});
		expect(block).toContain("$125.50 used");
		expect(block).toContain("of $500.00");
	});

	it("renders currentPeriod start and reset end", () => {
		const block = formatUsageBlock({
			history: [],
			currentPeriod: {
				start: "2026-01-01T00:00:00Z",
				end: "2026-02-01T00:00:00Z",
			},
		});
		expect(block).toContain("Period start: 2026-01-01T00:00:00Z");
		expect(block).toContain("Reset: 2026-02-01T00:00:00Z");
	});

	it("renders on-demand credits and cap", () => {
		const block = formatUsageBlock({
			history: [],
			onDemandUsedCents: 5_500,
			onDemandCapCents: 100_000,
		});
		expect(block).toContain("On-demand credits:");
		expect(block).toContain("$55.00 used");
		expect(block).toContain("of $1000.00");
	});

	it("renders prepaid balance", () => {
		const block = formatUsageBlock({ history: [], prepaidBalanceCents: 2_500 });
		expect(block).toContain("Prepaid balance: $25.00");
	});

	it("renders the on-demand enabled flag", () => {
		const onBlock = formatUsageBlock({ history: [], onDemandEnabled: true });
		expect(onBlock).toContain("On-demand billing: enabled");
		const offBlock = formatUsageBlock({ history: [], onDemandEnabled: false });
		expect(offBlock).toContain("On-demand billing: disabled");
	});

	it("renders the unified billing flag", () => {
		const block = formatUsageBlock({ history: [], isUnifiedBillingUser: true });
		expect(block).toContain("Usage pool: unified");
	});

	it("renders the validated history count", () => {
		const block = formatUsageBlock({
			history: [
				{ totalUsedCents: 1 },
				{ totalUsedCents: 2 },
			],
		});
		expect(block).toContain("Validated history periods: 2");
	});
});

// ─── fetchUsage (mocked fetch) ───────────────────────────────────────────────

describe("fetchUsage", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.restoreAllMocks();
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function userResponse(): Response {
		return new Response(JSON.stringify({ userId: "u1" }), {
			status: 200, headers: { "Content-Type": "application/json" },
		});
	}

	it("returns the parsed snapshot on a 200 billing response", async () => {
		globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
			const u = String(url);
			if (u.endsWith("/user")) return userResponse();
			if (u.includes("/billing")) {
				return new Response(JSON.stringify({ config: { creditUsagePercent: 30 } }), {
					status: 200, headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const snap = await fetchUsage("tok");
		expect(snap.creditUsagePercent).toBe(30);
	});

	it("forwards the resolved user id as x-userid on the billing call", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			const u = String(url);
			if (u.endsWith("/user")) return userResponse();
			if (u.includes("/billing")) {
				return new Response(JSON.stringify({ config: { creditUsagePercent: 0 } }), {
					status: 200, headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		await fetchUsage("tok");
		const billing = calls.find((c) => c.url.includes("/billing"));
		expect(billing).toBeDefined();
		expect((billing!.init!.headers as Record<string, string>)["x-userid"]).toBe("u1");
	});

	it("uses the cli-chat-proxy billing endpoint", async () => {
		globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
			const u = String(url);
			if (u.endsWith("/user")) return userResponse();
			if (u.includes("/billing")) {
				return new Response(JSON.stringify({}), {
					status: 200, headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
		await fetchUsage("tok");
		const billingUrl = (globalThis.fetch as any).mock.calls
			.map((c: unknown[]) => String(c[0]))
			.find((u: string) => u.includes("/billing"));
		expect(billingUrl).toBe(`${CLI_PROXY_BASE_URL}/billing?format=credits`);
	});

	it("rethrows as XaiUsageError auth when the /user lookup returns 401", async () => {
		globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
			if (String(url).endsWith("/user")) return new Response("unauth", { status: 401 });
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
		await expect(fetchUsage("tok")).rejects.toMatchObject({ code: "auth" });
	});

	it("throws XaiUsageError http when the billing endpoint returns 500", async () => {
		globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
			const u = String(url);
			if (u.endsWith("/user")) return userResponse();
			if (u.includes("/billing")) return new Response("nope", { status: 500 });
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
		await expect(fetchUsage("tok")).rejects.toMatchObject({ code: "http" });
	});

	it("rejects a 3xx response on the billing call (no redirect following)", async () => {
		globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
			const u = String(url);
			if (u.endsWith("/user")) return userResponse();
			if (u.includes("/billing")) {
				return new Response("", { status: 302, headers: { Location: "https://evil.example/leak" } });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
		await expect(fetchUsage("tok")).rejects.toBeInstanceOf(XaiUsageError);
	});

	it("rejects an over-complex billing body", async () => {
		let deep: unknown = { totalUsed: { val: 1 } };
		for (let i = 0; i < 50; i++) deep = { nested: deep };
		globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
			const u = String(url);
			if (u.endsWith("/user")) return userResponse();
			if (u.includes("/billing")) {
				return new Response(JSON.stringify(deep), {
					status: 200, headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
		await expect(fetchUsage("tok")).rejects.toBeInstanceOf(XaiUsageError);
	});

	it("throws when the user id is not printable ASCII", async () => {
		globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
			if (String(url).endsWith("/user")) {
				return new Response(JSON.stringify({ userId: "user id with spaces" }), {
					status: 200, headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
		await expect(fetchUsage("tok")).rejects.toMatchObject({ code: "invalid" });
	});
});

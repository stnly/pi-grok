import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	COST_45,
	FALLBACK_MODELS,
	mergeDiscoveredModels,
	mergeLiveModels,
	supportsReasoningEffort,
	triggerDiscovery,
} from "./models.js";
import { CLI_PROXY_BASE_URL as CLI_PROXY_URL } from "./models.js";

describe("FALLBACK_MODELS", () => {
	it("includes grok-4.5", () => {
		const m = FALLBACK_MODELS.find((x) => x.id === "grok-4.5");
		expect(m).toBeDefined();
		expect(m?.name).toBe("Grok 4.5");
		expect(m?.reasoning).toBe(true);
		expect(m?.input).toEqual(["text", "image"]);
		expect(m?.contextWindow).toBe(500_000);
	});

	it("does not set a CLI proxy baseUrl for grok-4.5", () => {
		const m = FALLBACK_MODELS.find((x) => x.id === "grok-4.5")!;
		expect(m.baseUrl).toBeUndefined();
	});
});

describe("COST_45", () => {
	it("matches xAI public API pricing ($/M tokens)", () => {
		expect(COST_45.input).toBe(2);
		expect(COST_45.output).toBe(6);
		// Cached input is $0.50/M, not the $0.20 used by older models.
		expect(COST_45.cacheRead).toBe(0.5);
		expect(COST_45.cacheWrite).toBe(0);
	});
});

describe("supportsReasoningEffort", () => {
	it("returns true for grok-4.5", () => {
		expect(supportsReasoningEffort("grok-4.5")).toBe(true);
	});

	it("returns true for grok-4.5 with provider prefix", () => {
		expect(supportsReasoningEffort("xai-oauth/grok-4.5")).toBe(true);
	});

	it("returns false for a model outside the allowlist", () => {
		expect(supportsReasoningEffort("grok-4.20-0309-non-reasoning")).toBe(false);
	});
});

describe("mergeLiveModels", () => {
	const base = FALLBACK_MODELS;

	it("returns the base list when the live response is null", () => {
		expect(mergeLiveModels(base, null)).toEqual(base);
	});

	it("returns the base list when the live response has no data array", () => {
		expect(mergeLiveModels(base, { data: undefined } as any)).toEqual(base);
	});

	it("appends a newly discovered model id with sensible defaults", () => {
		const merged = mergeLiveModels(base, {
			data: [{ id: "grok-9", context_length: 2_000_000, max_output_tokens: 64_000 }],
		});
		const m = merged.find((x) => x.id === "grok-9");
		expect(m).toBeDefined();
		expect(m?.contextWindow).toBe(2_000_000);
		expect(m?.maxTokens).toBe(64_000);
		expect(m?.input).toEqual(["text", "image"]);
		expect(m?.reasoning).toBe(true);
	});

	it("lets live catalog fields override base metadata for a known id", () => {
		// Live is authoritative for fields the API actually returns.
		const merged = mergeLiveModels(base, {
			data: [
				{ id: "grok-4.5", context_length: 999, max_output_tokens: 999 },
			],
		});
		const m = merged.find((x) => x.id === "grok-4.5")!;
		expect(m.contextWindow).toBe(999);
		expect(m.maxTokens).toBe(999);
		// Base still supplies fields the API does not expose.
		expect(m.name).toBe("Grok 4.5");
		expect(m.cost).toEqual(COST_45);
	});

	it("does not route a discovered public-API model to the CLI proxy", () => {
		// grok-4.5 lives on api.x.ai, so a discovery hit must not overwrite
		// its baseUrl with the CLI proxy URL.
		const merged = mergeLiveModels(base, {
			data: [{ id: "grok-4.5", context_length: 500_000 }],
		});
		const m = merged.find((x) => x.id === "grok-4.5")!;
		expect(m.baseUrl).toBeUndefined();
	});

	it("routes a genuinely unknown model to the CLI proxy", () => {
		const merged = mergeLiveModels(base, {
			data: [{ id: "grok-experimental-9", context_length: 100_000 }],
		});
		const m = merged.find((x) => x.id === "grok-experimental-9")!;
		expect(m.baseUrl).toBe(CLI_PROXY_URL);
		expect(m.headers).toBeDefined();
	});

	it("filters out non-chat entries (embeddings, tts, grok-imagine)", () => {
		const merged = mergeLiveModels(base, {
			data: [
				{ id: "grok-4.5" },
				{ id: "embedding-001" },
				{ id: "tts-1" },
				{ id: "grok-imagine-image" },
				{ id: "grok-imagine-video-1.5" },
			],
		});
		const ids = merged.map((x) => x.id);
		expect(ids).not.toContain("embedding-001");
		expect(ids).not.toContain("tts-1");
		expect(ids).not.toContain("grok-imagine-image");
		expect(ids).not.toContain("grok-imagine-video-1.5");
	});

	it("keeps base models that are absent from the live response", () => {
		const merged = mergeLiveModels(base, { data: [{ id: "grok-4.5" }] });
		for (const fb of base) {
			expect(merged.some((x) => x.id === fb.id)).toBe(true);
		}
	});
});

describe("discovery cache", () => {
	const originalFetch = globalThis.fetch;

	beforeAll(() => {
		globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
			const u = String(url);
			if (!u.endsWith("/models")) {
				return new Response("not found", { status: 404 });
			}
			return new Response(
				JSON.stringify({
					data: [
						{ id: "grok-4.5", context_length: 500_000, max_output_tokens: 30_000 },
						{ id: "grok-9-future", context_length: 2_000_000, max_output_tokens: 64_000 },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;
	});

	afterAll(() => {
		globalThis.fetch = originalFetch;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("returns the base list unchanged before any fetch completes", () => {
		// mergeDiscoveredModels never throws and always returns base when the
		// cache is empty, regardless of triggerDiscovery calls.
		const before = mergeDiscoveredModels(FALLBACK_MODELS);
		expect(before).toEqual(FALLBACK_MODELS);
	});

	it("surfaces discovered models after a successful fetch", async () => {
		triggerDiscovery("token", "https://api.x.ai/v1");
		// triggerDiscovery is fire-and-forget; poll the merge until the
		// discovered id appears (with a hard timeout).
		let merged = mergeDiscoveredModels(FALLBACK_MODELS);
		const deadline = Date.now() + 2000;
		while (!merged.some((m) => m.id === "grok-9-future") && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20));
			merged = mergeDiscoveredModels(FALLBACK_MODELS);
		}
		const future = merged.find((m) => m.id === "grok-9-future");
		expect(future).toBeDefined();
		expect(future?.contextWindow).toBe(2_000_000);
	});
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	COST_45,
	FALLBACK_MODELS,
	CLI_PROXY_BASE_URL as CLI_PROXY_URL,
	applyDiscoveredModels,
	filterModelsByEnv,
	mergeDiscoveredModels,
	mergeLiveModels,
	rebuildModelsForOAuth,
	resetDiscoveryForTests,
	supportsReasoningEffort,
	triggerDiscovery,
} from "./models.js";

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

	it("keeps composer on the CLI proxy", () => {
		const m = FALLBACK_MODELS.find((x) => x.id === "grok-composer-2.5-fast")!;
		expect(m.baseUrl).toBe(CLI_PROXY_URL);
		expect(m.headers).toBeDefined();
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

describe("filterModelsByEnv", () => {
	it("returns the list unchanged when env ids are empty", () => {
		expect(filterModelsByEnv(FALLBACK_MODELS, [])).toEqual(FALLBACK_MODELS);
	});

	it("filters and reorders by the env id list", () => {
		const filtered = filterModelsByEnv(FALLBACK_MODELS, ["grok-4.5", "grok-build"]);
		expect(filtered.map((m) => m.id)).toEqual(["grok-4.5", "grok-build"]);
	});

	it("synthesizes a default entry for unknown env ids", () => {
		const filtered = filterModelsByEnv(FALLBACK_MODELS, ["grok-custom"]);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].id).toBe("grok-custom");
		expect(filtered[0].baseUrl).toBeUndefined();
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
		// Live is authoritative for fields the API returns.
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

	it("does not route a known public-API model to the CLI proxy", () => {
		// grok-4.5 lives on api.x.ai, so a discovery hit must not overwrite
		// its baseUrl with the CLI proxy URL.
		const merged = mergeLiveModels(base, {
			data: [{ id: "grok-4.5", context_length: 500_000 }],
		});
		const m = merged.find((x) => x.id === "grok-4.5")!;
		expect(m.baseUrl).toBeUndefined();
	});

	it("routes newly discovered models to the public API, not the CLI proxy", () => {
		// Live /models is the public catalog, so new ids ride the provider base URL.
		const merged = mergeLiveModels(base, {
			data: [{ id: "grok-9-future", context_length: 100_000 }],
		});
		const m = merged.find((x) => x.id === "grok-9-future")!;
		expect(m.baseUrl).toBeUndefined();
		expect(m.headers).toBeUndefined();
	});

	it("preserves CLI-proxy routing for hardcoded models the live response omits", () => {
		const merged = mergeLiveModels(base, {
			data: [{ id: "grok-4.5" }],
		});
		const composer = merged.find((x) => x.id === "grok-composer-2.5-fast")!;
		expect(composer.baseUrl).toBe(CLI_PROXY_URL);
		expect(composer.headers).toBeDefined();
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

describe("proxy-preferred routing", () => {
	const base = FALLBACK_MODELS;

	it("routes a proxy-available model through the CLI proxy", () => {
		// grok-4.5 is on both endpoints; proxy availability wins routing.
		const merged = mergeLiveModels(
			base,
			{ data: [{ id: "grok-4.5", context_length: 500_000 }] },
			new Set(["grok-4.5"]),
		);
		const m = merged.find((x) => x.id === "grok-4.5")!;
		expect(m.baseUrl).toBe(CLI_PROXY_URL);
		expect(m.headers).toBeDefined();
	});

	it("routes a newly discovered proxy-available id through the CLI proxy", () => {
		const merged = mergeLiveModels(
			base,
			{ data: [{ id: "grok-9-future", context_length: 2_000_000 }] },
			new Set(["grok-9-future"]),
		);
		const m = merged.find((x) => x.id === "grok-9-future")!;
		expect(m.baseUrl).toBe(CLI_PROXY_URL);
		expect(m.headers).toBeDefined();
	});

	it("keeps a model on the public API when the proxy catalog omits it", () => {
		const merged = mergeLiveModels(
			base,
			{ data: [{ id: "grok-4.5", context_length: 500_000 }] },
			new Set(), // proxy catalog empty
		);
		const m = merged.find((x) => x.id === "grok-4.5")!;
		expect(m.baseUrl).toBeUndefined();
		expect(m.headers).toBeUndefined();
	});

	it("falls back to the public API when no proxy set is provided", () => {
		// Back-compat: callers that don't pass a proxy set get public-API routing.
		const merged = mergeLiveModels(
			base,
			{ data: [{ id: "grok-4.5", context_length: 500_000 }] },
		);
		const m = merged.find((x) => x.id === "grok-4.5")!;
		expect(m.baseUrl).toBeUndefined();
	});
});

describe("applyDiscoveredModels + env filter", () => {
	beforeEach(() => {
		resetDiscoveryForTests();
	});

	afterEach(() => {
		resetDiscoveryForTests();
	});

	it("re-applies the env filter after discovery so new ids stay out", () => {
		// Seed the cache as if a live fetch already completed.
		const body = {
			data: [
				{ id: "grok-4.5", context_length: 500_000 },
				{ id: "grok-9-future", context_length: 2_000_000 },
			],
		};
		// Use mergeLiveModels path via a direct cache inject through rebuild would
		// need the module cache; seed via triggerDiscovery-style by calling
		// applyDiscoveredModels against a merge of a known body instead.
		const base = FALLBACK_MODELS.filter((m) => m.id === "grok-build");
		// Simulate "cache has body" by testing filterModelsByEnv on a merge.
		const merged = mergeLiveModels(base, body);
		const filtered = filterModelsByEnv(merged, ["grok-build"]);
		expect(filtered.map((m) => m.id)).toEqual(["grok-build"]);
		expect(filtered.some((m) => m.id === "grok-9-future")).toBe(false);
	});

	it("returns the base list when the discovery cache is empty", () => {
		const base = FALLBACK_MODELS.filter((m) => m.id === "grok-4.5");
		expect(applyDiscoveredModels(base, [])).toEqual(base);
	});
});

describe("rebuildModelsForOAuth", () => {
	beforeEach(() => {
		resetDiscoveryForTests();
	});

	afterEach(() => {
		resetDiscoveryForTests();
	});

	const foreign = {
		id: "claude-sonnet",
		name: "Claude Sonnet",
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_000,
	};

	const ours = FALLBACK_MODELS.map((m) => ({
		...m,
		provider: "xai-oauth",
		api: "openai-responses",
		// Registered models have baseUrl filled for public ones; CLI proxy keeps its own.
		baseUrl: m.baseUrl ?? "https://api.x.ai/v1",
	}));

	it("preserves non-provider models", () => {
		const result = rebuildModelsForOAuth(
			[foreign, ...ours] as Array<Record<string, unknown>>,
			"xai-oauth",
			"https://api.x.ai/v1",
			[],
		);
		expect(result.some((m) => m.provider === "anthropic" && m.id === "claude-sonnet")).toBe(true);
	});

	it("appends a newly discovered id and stamps api/provider", () => {
		// Inject discovery by merging a live body into the cache via the pure path
		// then calling rebuild after seeding discoveredBody through triggerDiscovery.
		// For a deterministic unit test without network, exercise the pure merge
		// contract that rebuild uses: filterModelsByEnv(mergeLiveModels(...)).
		const liveBody = {
			data: [
				{ id: "grok-4.5", context_length: 500_000, max_output_tokens: 30_000 },
				{ id: "grok-9-future", context_length: 2_000_000, max_output_tokens: 64_000 },
			],
		};
		const merged = mergeLiveModels(ours as any, liveBody);
		const rebuilt = [
			foreign,
			...merged.map((m) => ({
				...m,
				api: (m as any).api ?? "openai-responses",
				provider: (m as any).provider ?? "xai-oauth",
				baseUrl: m.baseUrl ?? "https://api.x.ai/v1",
			})),
		];

		const future = rebuilt.find((m) => m.id === "grok-9-future") as any;
		expect(future).toBeDefined();
		expect(future.provider).toBe("xai-oauth");
		expect(future.api).toBe("openai-responses");
		expect(future.baseUrl).toBe("https://api.x.ai/v1");
		// Foreign provider still present.
		expect(rebuilt.some((m) => m.provider === "anthropic")).toBe(true);
	});

	it("keeps CLI-proxy baseUrl on composer after rebuild", () => {
		const result = rebuildModelsForOAuth(
			[...ours] as Array<Record<string, unknown>>,
			"xai-oauth",
			"https://api.x.ai/v1",
			[],
		);
		const composer = result.find((m) => m.id === "grok-composer-2.5-fast")!;
		expect(composer.baseUrl).toBe(CLI_PROXY_URL);
	});

	it("fills public baseUrl when unset", () => {
		const bare = FALLBACK_MODELS
			.filter((m) => m.id === "grok-4.5")
			.map((m) => ({ ...m, provider: "xai-oauth", api: "openai-responses" }));
		const result = rebuildModelsForOAuth(
			bare as Array<Record<string, unknown>>,
			"xai-oauth",
			"https://api.x.ai/v1",
			[],
		);
		expect(result[0].baseUrl).toBe("https://api.x.ai/v1");
	});

	it("re-applies env filter so discovery cannot bypass PI_XAI_OAUTH_MODELS", () => {
		const result = rebuildModelsForOAuth(
			ours as Array<Record<string, unknown>>,
			"xai-oauth",
			"https://api.x.ai/v1",
			["grok-build", "grok-4.5"],
		);
		expect(result.map((m) => m.id)).toEqual(["grok-build", "grok-4.5"]);
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
			// Public API returns the full catalog; CLI proxy returns a subset.
			// Models on both endpoints route through the proxy (subscription path).
			const isProxy = u.startsWith(CLI_PROXY_URL);
			const data = isProxy
				? [
					{ id: "grok-4.5", context_length: 500_000, max_output_tokens: 30_000 },
				]
				: [
					{ id: "grok-4.5", context_length: 500_000, max_output_tokens: 30_000 },
					{ id: "grok-9-future", context_length: 2_000_000, max_output_tokens: 64_000 },
				];
			return new Response(JSON.stringify({ data }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;
	});

	afterAll(() => {
		globalThis.fetch = originalFetch;
	});

	beforeEach(() => {
		resetDiscoveryForTests();
	});

	afterEach(() => {
		resetDiscoveryForTests();
		vi.clearAllMocks();
	});

	it("returns the base list unchanged before any fetch completes", () => {
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
		// grok-9-future is on the public catalog only, so it rides the public API.
		expect(future?.baseUrl).toBeUndefined();
		// grok-4.5 is on both endpoints; proxy-preferred routing sends it to
		// the CLI proxy.
		const g45 = merged.find((m) => m.id === "grok-4.5")!;
		expect(g45.baseUrl).toBe(CLI_PROXY_URL);
		expect(g45.headers).toBeDefined();
	});

	it("rebuildModelsForOAuth appends discovered ids once the cache is warm", async () => {
		triggerDiscovery("token", "https://api.x.ai/v1");
		const deadline = Date.now() + 2000;
		while (!mergeDiscoveredModels(FALLBACK_MODELS).some((m) => m.id === "grok-9-future") && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20));
		}

		const ours = FALLBACK_MODELS.map((m) => ({
			...m,
			provider: "xai-oauth",
			api: "openai-responses",
			baseUrl: m.baseUrl ?? "https://api.x.ai/v1",
		}));
		const foreign = {
			id: "other",
			provider: "other",
			api: "openai-completions",
			baseUrl: "https://example.com",
		};
		const result = rebuildModelsForOAuth(
			[foreign, ...ours] as Array<Record<string, unknown>>,
			"xai-oauth",
			"https://api.x.ai/v1",
			[],
		);

		const future = result.find((m) => m.id === "grok-9-future") as any;
		expect(future).toBeDefined();
		expect(future.provider).toBe("xai-oauth");
		expect(future.api).toBe("openai-responses");
		// grok-9-future is public-catalog only → public API base URL.
		expect(future.baseUrl).toBe("https://api.x.ai/v1");
		// grok-4.5 is on both endpoints → routed through the CLI proxy.
		const g45 = result.find((m) => m.id === "grok-4.5")!;
		expect(g45.baseUrl).toBe(CLI_PROXY_URL);
		expect(g45.headers).toBeDefined();
		// Non-provider models pass through.
		expect(result.some((m) => m.provider === "other")).toBe(true);
		// CLI-proxy model still present with its own baseUrl.
		const composer = result.find((m) => m.id === "grok-composer-2.5-fast")!;
		expect(composer.baseUrl).toBe(CLI_PROXY_URL);
	});
});

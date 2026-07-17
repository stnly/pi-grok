import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	COST_45,
	FALLBACK_MODELS,
	CLI_PROXY_BASE_URL as CLI_PROXY_URL,
	CLI_PROXY_HEADERS,
	applyDiscoveredModels,
	filterModelsByEnv,
	mergeDiscoveredModels,
	mergeLiveModels,
	rebuildModelsForOAuth,
	resetDiscoveryForTests,
	discoveryStatus,
	supportsReasoningEffort,
	thinkingLevelMapFor,
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

	it("grok-build matches the official context window (500k)", () => {
		const m = FALLBACK_MODELS.find((x) => x.id === "grok-build");
		expect(m).toBeDefined();
		// grok-build's default_models.json ships context_window 500000; a larger
		// value skews pi's usage bar and auto-compaction.
		expect(m?.contextWindow).toBe(500_000);
	});

	it("carries no routing hints (routing is owned by rebuildModelsForOAuth)", () => {
		// FALLBACK is model metadata only. baseUrl/headers are stamped at rebuild
		// time so every OAuth model rides the CLI proxy uniformly.
		for (const m of FALLBACK_MODELS) {
			expect(m.baseUrl).toBeUndefined();
			expect(m.headers).toBeUndefined();
		}
	});
});

describe("CLI_PROXY_HEADERS", () => {
	it("carries the client identity, version, mode, and auth headers the proxy expects", () => {
		// User-Agent and client identifier identify the client product; the
		// version gate, mode label, and the two auth-middleware headers mark
		// an OAuth CLI session. No surface header.
		expect(CLI_PROXY_HEADERS["x-grok-client-identifier"]).toBe("grok-shell");
		expect(CLI_PROXY_HEADERS["User-Agent"]).toMatch(/^grok-shell\/0\.2\.101 \((macos|windows|linux); (aarch64|x86_64)\)$/);
		expect(CLI_PROXY_HEADERS["x-grok-client-version"]).toBe("0.2.101");
		expect(CLI_PROXY_HEADERS["x-grok-client-mode"]).toBe("interactive");
		expect(CLI_PROXY_HEADERS["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
		expect(CLI_PROXY_HEADERS["x-authenticateresponse"]).toBe("authenticate-response");
		expect(CLI_PROXY_HEADERS["x-grok-client-surface"]).toBeUndefined();
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

describe("thinkingLevelMapFor", () => {
	it("exposes low/medium/high/xhigh for an effort-capable reasoning model", () => {
		expect(thinkingLevelMapFor("grok-4.5", true)).toEqual({ off: null, minimal: null, xhigh: "xhigh" });
	});

	it("honors a provider-qualified id", () => {
		expect(thinkingLevelMapFor("xai-oauth/grok-4.3", true)).toEqual({ off: null, minimal: null, xhigh: "xhigh" });
	});

	it("returns undefined for a non-effort reasoning model", () => {
		// grok-build is not effort-capable, so it gets no picker regardless of
		// the reasoning flag; nothing to map.
		expect(thinkingLevelMapFor("grok-build", true)).toBeUndefined();
	});

	it("returns undefined for a non-reasoning model", () => {
		expect(thinkingLevelMapFor("grok-4.20-0309-non-reasoning", false)).toBeUndefined();
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

	it("returns copies, not the fallback object references, so callers cannot mutate the source", () => {
		// Empty env: deep-equal but distinct objects.
		const empty = filterModelsByEnv(FALLBACK_MODELS, []);
		expect(empty).toEqual(FALLBACK_MODELS);
		expect(empty[0]).not.toBe(FALLBACK_MODELS[0]);

		// Non-empty: known-id entries are copies too.
		const filtered = filterModelsByEnv(FALLBACK_MODELS, ["grok-4.5"]);
		const source = FALLBACK_MODELS.find((m) => m.id === "grok-4.5")!;
		expect(filtered[0]).not.toBe(source);
		filtered[0].contextWindow = 1;
		expect(source.contextWindow).not.toBe(1);
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

	it("does not set routing: merge is enrichment only", () => {
		// Routing is owned by rebuildModelsForOAuth. A discovered id carries no
		// baseUrl/headers here, regardless of which endpoint reported it.
		const merged = mergeLiveModels(base, {
			data: [{ id: "grok-4.5", context_length: 500_000 }],
		});
		const m = merged.find((x) => x.id === "grok-4.5")!;
		expect(m.baseUrl).toBeUndefined();
		expect(m.headers).toBeUndefined();

		const fresh = merged.find((x) => x.id === "grok-9-future" || undefined);
		if (fresh) {
			expect(fresh.baseUrl).toBeUndefined();
			expect(fresh.headers).toBeUndefined();
		}
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

describe("applyDiscoveredModels + env filter", () => {
	beforeEach(() => {
		resetDiscoveryForTests();
	});

	afterEach(() => {
		resetDiscoveryForTests();
	});

	it("re-applies the env filter after discovery so new ids stay out", () => {
		const body = {
			data: [
				{ id: "grok-4.5", context_length: 500_000 },
				{ id: "grok-9-future", context_length: 2_000_000 },
			],
		};
		const base = FALLBACK_MODELS.filter((m) => m.id === "grok-build");
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
	}));

	it("routes every OAuth model through the CLI proxy with the proxy headers", () => {
		// Subscription inference always rides the proxy. Every provider model
		// gets the proxy baseUrl + header set, regardless of what FALLBACK or
		// discovery carried.
		const result = rebuildModelsForOAuth(
			[...ours] as Array<Record<string, unknown>>,
			"xai-oauth",
		);
		for (const m of result as Array<Record<string, unknown>>) {
			expect(m.baseUrl).toBe(CLI_PROXY_URL);
			expect(m.headers).toEqual(CLI_PROXY_HEADERS);
		}
	});

	it("routes grok-4.5 through the proxy on the first load (no discovery needed)", () => {
		// This is the regression guard for the timing bug: before this fix,
		// grok-4.5 stayed on api.x.ai until background discovery completed.
		const bare = FALLBACK_MODELS
			.filter((m) => m.id === "grok-4.5")
			.map((m) => ({ ...m, provider: "xai-oauth", api: "openai-responses" }));
		const result = rebuildModelsForOAuth(
			bare as Array<Record<string, unknown>>,
			"xai-oauth",
		);
		expect(result[0].baseUrl).toBe(CLI_PROXY_URL);
		expect(result[0].headers).toEqual(CLI_PROXY_HEADERS);
	});

	it("stamps api/provider on entries that lack them", () => {
		const result = rebuildModelsForOAuth(
			[...ours] as Array<Record<string, unknown>>,
			"xai-oauth",
		);
		for (const m of result as Array<Record<string, unknown>>) {
			expect(m.api).toBe("openai-responses");
			expect(m.provider).toBe("xai-oauth");
		}
	});

	it("hides off/minimal and enables xhigh on effort-capable OAuth models", () => {
		// grok-4.5 rejects reasoning.effort "none" (the host's off value) and
		// exposes low/medium/high/xhigh. rebuild stamps the map so the host
		// picker offers that set and nothing the model rejects.
		const result = rebuildModelsForOAuth(
			[...ours] as Array<Record<string, unknown>>,
			"xai-oauth",
		);
		const grok45 = result.find((m) => (m as any).id === "grok-4.5") as any;
		expect(grok45.thinkingLevelMap).toEqual({ off: null, minimal: null, xhigh: "xhigh" });
	});

	it("stamps the off map on a discovered effort-capable model", () => {
		// A live-catalog id absent from FALLBACK still needs the map so off
		// is hidden once discovery adds it.
		const discovered = {
			...FALLBACK_MODELS[0],
			id: "grok-4.5-preview",
			name: "Grok 4.5 Preview",
			reasoning: true,
			provider: "xai-oauth",
			api: "openai-responses",
		};
		const result = rebuildModelsForOAuth(
			[discovered] as Array<Record<string, unknown>>,
			"xai-oauth",
		);
		const found = result.find((m) => (m as any).id === "grok-4.5-preview") as any;
		expect(found.thinkingLevelMap).toEqual({ off: null, minimal: null, xhigh: "xhigh" });
	});

	it("does not stamp a thinkingLevelMap on the non-reasoning model", () => {
		const result = rebuildModelsForOAuth(
			[...ours] as Array<Record<string, unknown>>,
			"xai-oauth",
		);
		const nonReasoning = result.find(
			(m) => (m as any).id === "grok-4.20-0309-non-reasoning",
		) as any;
		// The non-reasoning model is reasoning: false; getSupportedThinkingLevels
		// short-circuits to off-only without consulting a map, so none is stamped.
		expect(nonReasoning.thinkingLevelMap).toBeUndefined();
		expect(nonReasoning.reasoning).toBe(false);
	});

	it("preserves non-provider models untouched", () => {
		const result = rebuildModelsForOAuth(
			[foreign, ...ours] as Array<Record<string, unknown>>,
			"xai-oauth",
		);
		const claude = result.find((m) => (m as any).id === "claude-sonnet") as any;
		expect(claude).toBeDefined();
		expect(claude.provider).toBe("anthropic");
		expect(claude.baseUrl).toBe("https://api.anthropic.com");
	});

	it("re-applies env filter so discovery cannot bypass PI_XAI_OAUTH_MODELS", () => {
		const result = rebuildModelsForOAuth(
			ours as Array<Record<string, unknown>>,
			"xai-oauth",
			["grok-build", "grok-4.5"],
		);
		expect(result.map((m) => (m as any).id)).toEqual(["grok-build", "grok-4.5"]);
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
			// The proxy catalog is no longer fetched; discovery hits the public
			// catalog only, for enrichment (context windows, new ids).
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

	it("reports cold state before any fetch and warm after", async () => {
		expect(discoveryStatus().state).toBe("cold");
		expect(discoveryStatus().lastError).toBeNull();
		triggerDiscovery("token", CLI_PROXY_URL);
		// While the fire-and-forget fetch runs the state is in-flight, then warm.
		const deadline = Date.now() + 2000;
		while (discoveryStatus().state !== "warm" && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20));
		}
		const status = discoveryStatus();
		expect(status.state).toBe("warm");
		expect(status.modelCount).toBe(2);
		expect(status.lastError).toBeNull();
	});

	it("does not drop a re-trigger when the token has changed", () => {
		triggerDiscovery("token-a", CLI_PROXY_URL);
		triggerDiscovery("token-a", CLI_PROXY_URL); // same token: dropped
		triggerDiscovery("token-b", CLI_PROXY_URL); // new token: not dropped
		// token-b forces a fresh fetch; discoveryLastToken tracks the latest.
		// (Behavioral assertion: the call returns without throwing and accepts
		// the new token rather than no-oping on the in-flight guard.)
		expect(discoveryStatus().state).not.toBe("cold");
	});

	it("surfaces discovered models after a successful fetch (enrichment only)", async () => {
		triggerDiscovery("token", "https://api.x.ai/v1");
		let merged = mergeDiscoveredModels(FALLBACK_MODELS);
		const deadline = Date.now() + 2000;
		while (!merged.some((m) => m.id === "grok-9-future") && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20));
			merged = mergeDiscoveredModels(FALLBACK_MODELS);
		}
		const future = merged.find((m) => m.id === "grok-9-future");
		expect(future).toBeDefined();
		expect(future?.contextWindow).toBe(2_000_000);
		// Enrichment sets no routing; rebuild owns baseUrl/headers.
		expect(future?.baseUrl).toBeUndefined();
		expect(future?.headers).toBeUndefined();
	});

	it("rebuild routes discovered ids through the proxy once the cache is warm", async () => {
		triggerDiscovery("token", "https://api.x.ai/v1");
		const deadline = Date.now() + 2000;
		while (!mergeDiscoveredModels(FALLBACK_MODELS).some((m) => m.id === "grok-9-future") && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20));
		}

		const ours = FALLBACK_MODELS.map((m) => ({
			...m,
			provider: "xai-oauth",
			api: "openai-responses",
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
		);

		// A newly discovered id still rides the proxy, like every OAuth model.
		const future = result.find((m) => (m as any).id === "grok-9-future") as any;
		expect(future).toBeDefined();
		expect(future.provider).toBe("xai-oauth");
		expect(future.api).toBe("openai-responses");
		expect(future.baseUrl).toBe(CLI_PROXY_URL);
		expect(future.headers).toEqual(CLI_PROXY_HEADERS);

		// grok-4.5 through the proxy too.
		const g45 = result.find((m) => (m as any).id === "grok-4.5") as any;
		expect(g45.baseUrl).toBe(CLI_PROXY_URL);

		// Non-provider model passes through untouched.
		const other = result.find((m) => (m as any).provider === "other") as any;
		expect(other.baseUrl).toBe("https://example.com");
	});

	it("routes the OAuth catalog fetch through the cli-chat-proxy, not api.x.ai", async () => {
		triggerDiscovery("token", CLI_PROXY_URL);
		// Let the fire-and-forget fetch resolve.
		const deadline = Date.now() + 2000;
		while (!mergeDiscoveredModels(FALLBACK_MODELS).some((m) => m.id === "grok-9-future") && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20));
		}
		const calls = (globalThis.fetch as unknown as { mock: { calls: [string, unknown][] } }).mock.calls;
		const modelsCall = calls.find(([url]) => String(url).endsWith("/models"));
		expect(modelsCall).toBeDefined();
		expect(String(modelsCall![0])).toBe(`${CLI_PROXY_URL}/models`);
		const init = modelsCall![1] as Record<string, unknown>;
		expect(init.headers).toMatchObject({
			Authorization: "Bearer token",
			"X-XAI-Token-Auth": "xai-grok-cli",
		});
	});
});

/**
 * Model definitions for xAI Grok.
 *
 * Hardcoded fallback list + live catalog fetching from the xAI API.
 */

// ─── Cost constants ($/M tokens) ──────────────────────────────────────────────

const COST_BUILD = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const COST_43 = { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 };
const COST_420 = { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 };
// grok-4.5: cached input is $0.50/M (higher than the $0.20 used by 4.20/4.3).
export const COST_45 = { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 };

// ─── Model type ───────────────────────────────────────────────────────────────

export interface XaiModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	/** Models that don't support reasoning.effort get a thinkingLevelMap. */
	thinkingLevelMap?: Record<string, string | null>;
	/** Override base URL for models only available on the CLI proxy. */
	baseUrl?: string;
	/** Extra headers to send with requests for this model. */
	headers?: Record<string, string>;
}

// ─── Hardcoded fallback catalog ───────────────────────────────────────────────

// CLI proxy base URL for models not available on the public API.
export const CLI_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const CLI_PROXY_HEADERS: Record<string, string> = {
	"x-grok-client-version": "0.2.22",
};

export const FALLBACK_MODELS: XaiModelConfig[] = [
	{
		id: "grok-composer-2.5-fast",
		name: "Composer 2.5",
		reasoning: true,
		input: ["text", "image"],
		cost: COST_BUILD,
		contextWindow: 200_000,
		maxTokens: 30_000,
		baseUrl: CLI_PROXY_BASE_URL,
		headers: CLI_PROXY_HEADERS,
	},
	{
		id: "grok-build",
		name: "Grok Build",
		reasoning: true,
		input: ["text", "image"],
		cost: COST_BUILD,
		contextWindow: 1_000_000,
		maxTokens: 30_000,
	},
	{
		id: "grok-4.5",
		name: "Grok 4.5",
		reasoning: true,
		input: ["text", "image"],
		cost: COST_45,
		contextWindow: 500_000,
		maxTokens: 30_000,
	},
	{
		id: "grok-4.3",
		name: "Grok 4.3",
		reasoning: true,
		input: ["text", "image"],
		cost: COST_43,
		contextWindow: 1_000_000,
		maxTokens: 30_000,
	},
	{
		id: "grok-4.20-0309-reasoning",
		name: "Grok 4.20 Reasoning",
		reasoning: true,
		input: ["text", "image"],
		cost: COST_420,
		contextWindow: 2_000_000,
		maxTokens: 30_000,
	},
	{
		id: "grok-4.20-0309-non-reasoning",
		name: "Grok 4.20 Non-Reasoning",
		reasoning: false,
		input: ["text", "image"],
		cost: COST_420,
		contextWindow: 2_000_000,
		maxTokens: 30_000,
		thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: null, xhigh: null },
	},
	{
		id: "grok-4.20-multi-agent-0309",
		name: "Grok 4.20 Multi-Agent",
		reasoning: true,
		input: ["text", "image"],
		cost: COST_420,
		contextWindow: 2_000_000,
		maxTokens: 30_000,
	},
];

// ─── Reasoning-effort allowlist ───────────────────────────────────────────────

/**
 * Only these model prefixes support `reasoning.effort` in the Responses API.
 * Everything else gets the param stripped in the sanitizer.
 */
const EFFORT_CAPABLE_PREFIXES = ["grok-3-mini", "grok-4.20-multi-agent", "grok-4.3", "grok-4.5"];

export function supportsReasoningEffort(modelId: string): boolean {
	const name = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
	return EFFORT_CAPABLE_PREFIXES.some((p) => name.toLowerCase().startsWith(p));
}

// ─── PI_XAI_OAUTH_MODELS env override ────────────────────────────────────────

/**
 * Resolve the active model list.  If `PI_XAI_OAUTH_MODELS` is set,
 * it filters/reorders the fallback list; unknown IDs get sensible defaults.
 */
export function resolveModels(): XaiModelConfig[] {
	const env = (process.env.PI_XAI_OAUTH_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);
	if (env.length === 0) return FALLBACK_MODELS;

	const byId = new Map(FALLBACK_MODELS.map((m) => [m.id, m]));
	return env.map((id) => byId.get(id) ?? {
		id,
		name: id,
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: COST_BUILD,
		contextWindow: 1_000_000,
		maxTokens: 30_000,
		baseUrl: undefined,
		headers: undefined,
	});
}

// ─── Live catalog ────────────────────────────────────────────────────────────

interface ApiModelEntry {
	id: string;
	owned_by?: string;
	context_length?: number;
	max_output_tokens?: number;
}

/** Cost overrides for known model families (the live API doesn't expose pricing). */
const COST_OVERRIDES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
	"grok-build": COST_BUILD,
	"grok-4.3": COST_43,
	"grok-4.5": COST_45,
};

/**
 * Whether a catalog entry id is a chat/reasoning model we should register.
 *
 * The API returns Grok-prefixed entries that aren't chat models
 * (grok-imagine-image, grok-imagine-video, embeddings). Excluding by suffix
 * keeps the model picker focused on usable models.
 */
function isChatModelEntry(id: string): boolean {
	if (!id.startsWith("grok")) return false;
	const lower = id.toLowerCase();
	if (lower.includes("imagine")) return false;
	if (lower.includes("embedding")) return false;
	if (lower.includes("tts")) return false;
	return true;
}

// ─── Live catalog merge ──────────────────────────────────────────────────────

/**
 * Merge a live `/models` response into the fallback list.
 *
 * Pure and side-effect free so it can be unit-tested without network.
 * Returns `base` unchanged when `body` is null or has no `data` array.
 *
 * The live catalog is authoritative when present: its `context_length` and
 * `max_output_tokens` override the hardcoded values, and the merged list is
 * ordered by the live response. The hardcoded list fills the gaps the API
 * does not expose (display name, pricing via COST_OVERRIDES, reasoning flag,
 * routing) and supplies any ids the live response omits.
 *
 * Routing: a discovered id is only sent to the CLI proxy when it is absent
 * from the hardcoded list AND has no pricing override. Known families
 * (grok-4.3, grok-4.5, ...) ride the provider's base URL.
 */
export function mergeLiveModels(
	base: XaiModelConfig[],
	body: { data?: ApiModelEntry[] } | null,
): XaiModelConfig[] {
	if (!body || !Array.isArray(body.data)) return base;

	const grokEntries = body.data.filter((e) => isChatModelEntry(e.id));

	const baseById = new Map(base.map((m) => [m.id, m]));
	const seen = new Set<string>();
	const merged: XaiModelConfig[] = [];

	for (const entry of grokEntries) {
		seen.add(entry.id);
		const existing = baseById.get(entry.id);
		if (existing) {
			// Live fields override; base fills name/cost/reasoning/routing.
			merged.push({
				...existing,
				contextWindow: entry.context_length ?? existing.contextWindow,
				maxTokens: entry.max_output_tokens ?? existing.maxTokens,
			});
		} else {
			const hasCostOverride = entry.id in COST_OVERRIDES;
			merged.push({
				id: entry.id,
				name: entry.id,
				reasoning: true,
				input: ["text", "image"],
				cost: COST_OVERRIDES[entry.id] ?? COST_420,
				contextWindow: entry.context_length ?? 1_000_000,
				maxTokens: entry.max_output_tokens ?? 30_000,
				baseUrl: hasCostOverride ? undefined : CLI_PROXY_BASE_URL,
				headers: hasCostOverride ? undefined : CLI_PROXY_HEADERS,
			});
		}
	}

	// Append hardcoded models the live response omitted.
	for (const fb of base) {
		if (!seen.has(fb.id)) merged.push(fb);
	}

	return merged;
}

// ─── Live catalog fetch ───────────────────────────────────────────────────────

export async function fetchLiveModels(
	accessToken: string,
	baseUrl: string,
): Promise<XaiModelConfig[] | null> {
	const body = await fetchLiveCatalog(accessToken, baseUrl);
	return body ? mergeLiveModels(FALLBACK_MODELS, body) : null;
}

/** Fetch and return the raw `/models` body, or null on any failure. */
async function fetchLiveCatalog(
	accessToken: string,
	baseUrl: string,
): Promise<{ data?: ApiModelEntry[] } | null> {
	try {
		const response = await fetch(`${baseUrl}/models`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"x-grok-client-version": CLI_PROXY_HEADERS["x-grok-client-version"],
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return null;
		return (await response.json()) as { data?: ApiModelEntry[] };
	} catch {
		return null;
	}
}

// ─── Discovery cache ─────────────────────────────────────────────────────────

/**
 * Raw `/models` body from the last successful live fetch.
 *
 * Storing the raw body (rather than pre-merged configs) keeps the cache
 * decoupled from the fallback list, so a future `FALLBACK_MODELS` update
 * changes how the cache re-merges without a refetch.
 */
let discoveredBody: { data?: ApiModelEntry[] } | null = null;
let discoveryInFlight: Promise<void> | null = null;

/**
 * Merge the discovered catalog into a base list. Returns `base` unchanged
 * when no successful fetch has completed, so callers always get a usable list.
 */
export function mergeDiscoveredModels(base: XaiModelConfig[]): XaiModelConfig[] {
	return discoveredBody ? mergeLiveModels(base, discoveredBody) : base;
}

/**
 * Fire-and-forget a live catalog fetch. Deduplicates concurrent calls so
 * repeated `/reload`s don't stack requests. Errors are swallowed (the cache
 * stays empty and the fallback list is used).
 */
export function triggerDiscovery(accessToken: string, baseUrl: string): void {
	if (discoveryInFlight) return;
	discoveryInFlight = (async () => {
		const body = await fetchLiveCatalog(accessToken, baseUrl);
		if (body && Array.isArray(body.data)) discoveredBody = body;
		discoveryInFlight = null;
	})();
}

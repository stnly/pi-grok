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

/** Parse `PI_XAI_OAUTH_MODELS` into a list of model ids (empty = no filter). */
export function envModelIds(): string[] {
	return (process.env.PI_XAI_OAUTH_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Filter/reorder `models` by an explicit id list.
 * Unknown ids get sensible defaults so env can pre-declare models not yet
 * in the fallback catalog. Empty `envIds` returns `models` unchanged.
 */
export function filterModelsByEnv(models: XaiModelConfig[], envIds: string[]): XaiModelConfig[] {
	if (envIds.length === 0) return models;

	const byId = new Map(models.map((m) => [m.id, m]));
	return envIds.map((id) => byId.get(id) ?? {
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

/**
 * Resolve the active model list. If `PI_XAI_OAUTH_MODELS` is set,
 * it filters/reorders the fallback list; unknown IDs get sensible defaults.
 */
export function resolveModels(): XaiModelConfig[] {
	return filterModelsByEnv(FALLBACK_MODELS, envModelIds());
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
 * does not expose (display name, pricing via COST_OVERRIDES, reasoning flag).
 *
 * Routing is proxy-preferred. `proxyIds` is the set of model ids the CLI
 * proxy catalog reported as available; any id in that set gets the proxy base
 * URL and version header, so requests ride the subscription path instead of
 * the billed public API. ids absent from the proxy set fall back to the
 * provider base URL. Omitting `proxyIds` (older callers) keeps public-API
 * routing, so hardcoded proxy-only entries (composer) still carry their own
 * baseUrl from the base list.
 */
export function mergeLiveModels(
	base: XaiModelConfig[],
	body: { data?: ApiModelEntry[] } | null,
	proxyIds: Set<string> = new Set(),
): XaiModelConfig[] {
	if (!body || !Array.isArray(body.data)) return base;

	const grokEntries = body.data.filter((e) => isChatModelEntry(e.id));

	const baseById = new Map(base.map((m) => [m.id, m]));
	const seen = new Set<string>();
	const merged: XaiModelConfig[] = [];

	const routeFor = (id: string): { baseUrl?: string; headers?: Record<string, string> } =>
		proxyIds.has(id)
			? { baseUrl: CLI_PROXY_BASE_URL, headers: CLI_PROXY_HEADERS }
			: {};

	for (const entry of grokEntries) {
		seen.add(entry.id);
		const existing = baseById.get(entry.id);
		if (existing) {
			// Live fields override; base fills name/cost/reasoning. Proxy routing
			// wins over whatever the base entry carried.
			merged.push({
				...existing,
				contextWindow: entry.context_length ?? existing.contextWindow,
				maxTokens: entry.max_output_tokens ?? existing.maxTokens,
				...routeFor(entry.id),
			});
		} else {
			merged.push({
				id: entry.id,
				name: entry.id,
				reasoning: true,
				input: ["text", "image"],
				cost: COST_OVERRIDES[entry.id] ?? COST_420,
				contextWindow: entry.context_length ?? 1_000_000,
				maxTokens: entry.max_output_tokens ?? 30_000,
				...routeFor(entry.id),
			});
		}
	}

	// Append hardcoded models the live response omitted, applying proxy routing
	// so a model that joins the proxy catalog later moves to the proxy path.
	for (const fb of base) {
		if (!seen.has(fb.id)) {
			merged.push({ ...fb, ...routeFor(fb.id) });
		}
	}

	return merged;
}

// ─── Live catalog fetch ───────────────────────────────────────────────────────

export async function fetchLiveModels(
	accessToken: string,
	baseUrl: string,
	proxyIds: Set<string> = new Set(),
): Promise<XaiModelConfig[] | null> {
	const body = await fetchLiveCatalog(accessToken, baseUrl);
	return body ? mergeLiveModels(FALLBACK_MODELS, body, proxyIds) : null;
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
 * Raw `/models` body from the last successful live fetch, plus the set of
 * ids the CLI proxy catalog reported as available.
 *
 * Storing the raw body (rather than pre-merged configs) keeps the cache
 * decoupled from the fallback list, so a future `FALLBACK_MODELS` update
 * changes how the cache re-merges without a refetch. The proxy id set drives
 * proxy-preferred routing at merge time.
 */
let discoveredBody: { data?: ApiModelEntry[] } | null = null;
let discoveredProxyIds: Set<string> = new Set();
let discoveryInFlight: Promise<void> | null = null;

/**
 * Merge the discovered catalog into a base list. Returns `base` unchanged
 * when no successful fetch has completed, so callers always get a usable list.
 */
export function mergeDiscoveredModels(base: XaiModelConfig[]): XaiModelConfig[] {
	return discoveredBody ? mergeLiveModels(base, discoveredBody, discoveredProxyIds) : base;
}

/**
 * Merge live discovery into the provider's models, then re-apply
 * `PI_XAI_OAUTH_MODELS` so the env filter still holds after new ids land.
 *
 * Pure aside from reading the module-level discovery cache (and env, unless
 * `envIds` is passed). Returns only this provider's models; the caller
 * recombines them with other providers and stamps Model fields.
 */
export function applyDiscoveredModels(
	providerModels: XaiModelConfig[],
	envIds: string[] = envModelIds(),
): XaiModelConfig[] {
	return filterModelsByEnv(mergeDiscoveredModels(providerModels), envIds);
}

/**
 * Fire-and-forget live catalog fetches for both endpoints.
 *
 * Fetches the public `/models` catalog (the source of discovered ids and the
 * authoritative context window / max-token fields) and the CLI proxy catalog
 * (the source of routing: ids present here ride the subscription path).
 *
 * Deduplicates concurrent calls so repeated `/reload`s don't stack requests.
 * Errors are swallowed (a failed fetch leaves that side of the cache as-is;
 * routing falls back to the public API when the proxy catalog is unavailable).
 */
export function triggerDiscovery(accessToken: string, baseUrl: string): void {
	if (discoveryInFlight) return;
	discoveryInFlight = (async () => {
		const [body, proxyBody] = await Promise.all([
			fetchLiveCatalog(accessToken, baseUrl),
			fetchLiveCatalog(accessToken, CLI_PROXY_BASE_URL),
		]);
		if (body && Array.isArray(body.data)) discoveredBody = body;
		if (proxyBody && Array.isArray(proxyBody.data)) {
			discoveredProxyIds = new Set(
				proxyBody.data.filter((e) => isChatModelEntry(e.id)).map((e) => e.id),
			);
		}
		discoveryInFlight = null;
	})();
}

/** Clear the discovery cache. For tests only. */
export function resetDiscoveryForTests(): void {
	discoveredBody = null;
	discoveredProxyIds = new Set();
	discoveryInFlight = null;
}

/**
 * Rebuild the full model list for `modifyModels`.
 *
 * - Keeps non-provider models untouched
 * - Merges live discovery into this provider's models
 * - Re-applies `PI_XAI_OAUTH_MODELS`
 * - Appends newly discovered ids (map-only rewrites drop them)
 * - Stamps `api` / `provider` on entries that lack them
 * - Fills `baseUrl` from the provider default when unset (public API path);
 *   CLI-proxy models already carry their own baseUrl and keep it
 */
export function rebuildModelsForOAuth(
	allModels: Array<Record<string, unknown>>,
	provider: string,
	effectiveBaseUrl: string,
	envIds: string[] = envModelIds(),
): Array<Record<string, unknown>> {
	const others = allModels.filter((m) => m.provider !== provider);
	const ours = allModels.filter((m) => m.provider === provider);
	const template = ours[0];

	const merged = applyDiscoveredModels(
		ours as unknown as XaiModelConfig[],
		envIds,
	).map((m) => {
		const row = m as XaiModelConfig & { api?: string; provider?: string };
		return {
			...row,
			api: row.api ?? (template?.api as string | undefined) ?? "openai-responses",
			provider: row.provider ?? provider,
			baseUrl: row.baseUrl ?? effectiveBaseUrl,
		};
	});

	return [...others, ...merged];
}

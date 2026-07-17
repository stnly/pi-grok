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
	/** Per-level overrides for the host's thinking-level picker. */
	thinkingLevelMap?: Record<string, string | null>;
	/** Base URL for requests to this model (stamped uniformly to the CLI proxy). */
	baseUrl?: string;
	/** Headers to send with requests for this model. */
	headers?: Record<string, string>;
}

// ─── Hardcoded fallback catalog ───────────────────────────────────────────────

// CLI proxy base URL for models not available on the public API.
export const CLI_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

/**
 * Client version label sent on cli-chat-proxy requests. The proxy rejects
 * requests whose version it does not admit, so this is coupled to the proxy's
 * accepted set. Override with `PI_XAI_CLIENT_VERSION` to track a newer client
 * before a release ships the bump.
 */
const GROK_CLIENT_VERSION = process.env.PI_XAI_CLIENT_VERSION || "0.2.101";

/** Session product label, overridable via `PI_XAI_CLIENT_NAME`. */
const CLIENT_IDENTIFIER = process.env.PI_XAI_CLIENT_NAME || "grok-shell";

/**
 * Map Node's platform/arch names to the labels the proxy expects so the
 * User-Agent matches what a native client would send (`macos`/`windows`,
 * `aarch64`/`x86_64`). Unknown values pass through unchanged.
 */
function platformLabel(): string {
	const os = process.platform === "darwin" ? "macos"
		: process.platform === "win32" ? "windows"
		: process.platform;
	const arch = process.arch === "arm64" ? "aarch64"
		: process.arch === "x64" ? "x86_64"
		: process.arch;
	return `${os}; ${arch}`;
}

/**
 * Headers every cli-chat-proxy request carries: the User-Agent and client
 * identifier, the version its gate checks, the mode label, and the two
 * auth-middleware headers that tell the proxy this is an OAuth CLI session.
 * Reused by inference, model discovery, account, privacy, and x-search so
 * every proxy request carries the same identity.
 */
export const CLI_PROXY_HEADERS: Record<string, string> = Object.freeze({
	"User-Agent": `${CLIENT_IDENTIFIER}/${GROK_CLIENT_VERSION} (${platformLabel()})`,
	"x-grok-client-identifier": CLIENT_IDENTIFIER,
	"x-grok-client-version": GROK_CLIENT_VERSION,
	"x-grok-client-mode": "interactive",
	"X-XAI-Token-Auth": "xai-grok-cli",
	"x-authenticateresponse": "authenticate-response",
});

export const FALLBACK_MODELS: XaiModelConfig[] = [
	{
		id: "grok-composer-2.5-fast",
		name: "Composer 2.5",
		reasoning: true,
		input: ["text", "image"],
		cost: COST_BUILD,
		contextWindow: 200_000,
		maxTokens: 30_000,
	},
	{
		id: "grok-build",
		name: "Grok Build",
		reasoning: true,
		input: ["text", "image"],
		cost: COST_BUILD,
		contextWindow: 500_000,
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

/**
 * Thinking-level map for a model. Effort-capable reasoning models reject
 * `reasoning.effort: "none"` (the host's "thinking off" value), so hide
 * "off" from the picker. The set mirrors what a native client exposes for
 * these models: low, medium, high, xhigh. "off" and "minimal" are dropped
 * (the model rejects none; minimal is not exposed), and xhigh is opted in
 * (the host hides xhigh unless it is mapped to a non-null value). Returns
 * undefined for non-reasoning or non-effort-capable models so an explicit
 * map on the entry (or no map at all) is left untouched.
 */
export function thinkingLevelMapFor(
	modelId: string,
	reasoning: boolean,
): Record<string, string | null> | undefined {
	if (!reasoning || !supportsReasoningEffort(modelId)) return undefined;
	return { off: null, minimal: null, xhigh: "xhigh" };
}

// ─── PI_XAI_OAUTH_MODELS env override ────────────────────────────────────────

/** Parse `PI_XAI_OAUTH_MODELS` into a list of model ids (empty = no filter). */
export function envModelIds(): string[] {
	return (process.env.PI_XAI_OAUTH_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Filter/reorder `models` by an explicit id list, returning shallow copies.
 * Unknown ids get sensible defaults so env can pre-declare models not yet
 * in the fallback catalog. Copies (not the original references) are returned
 * so a downstream mutator cannot poison the fallback list for the process.
 */
export function filterModelsByEnv(models: XaiModelConfig[], envIds: string[]): XaiModelConfig[] {
	if (envIds.length === 0) return models.map((m) => ({ ...m }));

	const byId = new Map(models.map((m) => [m.id, m]));
	return envIds.map((id) => {
		const found = byId.get(id);
		return found ? { ...found } : {
			id,
			name: id,
			reasoning: true,
			input: ["text"] as ("text" | "image")[],
			cost: COST_BUILD,
			contextWindow: 1_000_000,
			maxTokens: 30_000,
			baseUrl: undefined,
			headers: undefined,
		};
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
 * This is enrichment only: the live catalog is authoritative for
 * `context_length` and `max_output_tokens`, the merged list follows the live
 * response order, and newly discovered ids get sensible defaults. It does not
 * set routing. `rebuildModelsForOAuth` is the single routing authority and
 * sends every OAuth model through the CLI proxy, so merge stays decoupled
 * from how requests reach xAI.
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
			// Live fields override; base fills name/cost/reasoning.
			merged.push({
				...existing,
				contextWindow: entry.context_length ?? existing.contextWindow,
				maxTokens: entry.max_output_tokens ?? existing.maxTokens,
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
				...CLI_PROXY_HEADERS,
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
 * changes how the cache re-merges without a refetch. Discovery is enrichment
 * only; routing is static and owned by `rebuildModelsForOAuth`.
 */
let discoveredBody: { data?: ApiModelEntry[] } | null = null;
let discoveryInFlight: Promise<void> | null = null;
let discoveryLastToken: string | null = null;
let discoveryLastError: string | null = null;
let discoveryFetchedAt = 0; // epoch ms of the last successful fetch, 0 = never

/**
 * Merge the discovered catalog into a base list. Returns `base` unchanged
 * when no successful fetch has completed, so callers always get a usable list.
 */
export function mergeDiscoveredModels(base: XaiModelConfig[]): XaiModelConfig[] {
	return discoveredBody ? mergeLiveModels(base, discoveredBody) : base;
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
 * Fire-and-forget live catalog fetch.
 *
 * Fetches the OAuth session's `/models` catalog from the cli-chat-proxy for
 * enrichment: discovered ids and authoritative context window / max-token
 * fields. The caller passes the proxy base URL so the fetch carries the
 * session's proxy identity headers and never touches api.x.ai (the API-key
 * path). Model routing is static and set in rebuildModelsForOAuth.
 *
 * Deduplicates concurrent calls so repeated `/reload`s don't stack requests.
 * Errors are swallowed (a failed fetch leaves the cache as-is).
 */
export function triggerDiscovery(accessToken: string, baseUrl: string): void {
	// A second trigger while one is in flight is dropped only when it is for
	// the same token. A token change (re-login, refresh) means the cached body
	// may belong to a different session, so kick off a fresh fetch.
	if (discoveryInFlight && discoveryLastToken === accessToken) return;
	discoveryLastToken = accessToken;
	discoveryInFlight = (async () => {
		try {
			const body = await fetchLiveCatalog(accessToken, baseUrl);
			if (body && Array.isArray(body.data)) {
				discoveredBody = body;
				discoveryLastError = null;
				discoveryFetchedAt = Date.now();
			} else if (body === null) {
				// fetchLiveCatalog returns null on network/HTTP failure; record so
				// /xai-status can explain why the catalog looks stale.
				discoveryLastError = "catalog fetch failed";
			}
		} catch (err) {
			discoveryLastError = err instanceof Error ? err.message : String(err);
		} finally {
			discoveryInFlight = null;
		}
	})();
}

/** Snapshot of the discovery cache for `/xai-status`. `cold` means no
 * successful fetch has completed yet; `in-flight` means one is running;
 * `warm` means the cache holds a catalog body. */
export function discoveryStatus(): {
	state: "cold" | "in-flight" | "warm";
	modelCount: number;
	lastError: string | null;
} {
	let state: "cold" | "in-flight" | "warm";
	if (discoveryInFlight) state = "in-flight";
	else if (discoveredBody) state = "warm";
	else state = "cold";
	return {
		state,
		modelCount: discoveredBody?.data?.length ?? 0,
		lastError: discoveryLastError,
	};
}

/** Clear the discovery cache. For tests only. */
export function resetDiscoveryForTests(): void {
	discoveredBody = null;
	discoveryInFlight = null;
	discoveryLastToken = null;
	discoveryLastError = null;
	discoveryFetchedAt = 0;
}

/**
 * Rebuild the full model list for `modifyModels`.
 *
 * - Keeps non-provider models untouched
 * - Merges live discovery into this provider's models (enrichment only)
 * - Re-applies `PI_XAI_OAUTH_MODELS`
 * - Appends newly discovered ids (map-only rewrites drop them)
 * - Stamps `api` / `provider` on entries that lack them
 * - Routes every OAuth model through the CLI proxy with the proxy header
 *   set, so subscription inference rides the proxy from the first load.
 */
export function rebuildModelsForOAuth(
	allModels: Array<Record<string, unknown>>,
	provider: string,
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
		const thinkingLevelMap = row.thinkingLevelMap ?? thinkingLevelMapFor(row.id, row.reasoning);
		return {
			...row,
			api: row.api ?? (template?.api as string | undefined) ?? "openai-responses",
			provider: row.provider ?? provider,
			baseUrl: CLI_PROXY_BASE_URL,
			headers: { ...CLI_PROXY_HEADERS },
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		};
	});

	return [...others, ...merged];
}

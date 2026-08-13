/**
 * Model definitions for xAI Grok.
 *
 * Hardcoded fallback list + live catalog fetching from the xAI API.
 */

import { readBoundedJson, RedirectError, safeFetch } from "./safe-fetch.js";
import {
	CATALOG_BOUNDED_JSON_OPTIONS,
	CATALOG_FRESH_TTL_MS,
	loadCachedCatalog,
	writeCachedCatalog,
} from "./catalog-cache.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

// ─── Cost constants ($/M tokens, base <200k-prompt tier) ───────────────────────
// From the xAI public pricing page. The cost shape is flat, so the base tier
// is used; long-context (>=200k prompt) pricing is not modeled. cacheWrite is
// not published for these models, so it stays 0.
const COST_BUILD = { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 };
const COST_43 = { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 };
const COST_420 = { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 };
// grok-4.5 and grok-4.6: cached input is $0.50/M (higher than the $0.20 used by
// 4.20/4.3). grok-4.6 shipped at the same per-token price as grok-4.5.
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

/** On-disk cache path for the live catalog body. Resolves the agent directory
 * at first use; tests can override via _setCatalogCachePathForTests. Returns
 * an empty string when the agent directory can't be resolved (eg. running
 * the unit tests outside a pi install). */
function defaultCatalogCachePath(): string {
	try {
		return join(getAgentDir(), "cache", "pi-grok", "models.json");
	} catch {
		return "";
	}
}

/** Path used for the on-disk cache. Overridable for tests via _setCatalogCachePathForTests. */
let catalogCachePath = defaultCatalogCachePath();

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
 * Identity headers for a cli-chat-proxy request: the User-Agent and client
 * identifier, the version the proxy's gate checks, the mode label, and the two
 * auth-middleware headers that mark an OAuth CLI session. When `modelId` is
 * given (an inference request), `x-grok-model-override` is added so the proxy
 * routes to that model; account and catalog calls omit it.
 *
 * Returns a fresh object per call so callers can safely add per-request keys
 * (Authorization, Content-Type) without aliasing a shared constant.
 */
export function buildProxyHeaders(modelId?: string): Record<string, string> {
	const headers: Record<string, string> = {
		"User-Agent": `${CLIENT_IDENTIFIER}/${GROK_CLIENT_VERSION} (${platformLabel()})`,
		"x-grok-client-identifier": CLIENT_IDENTIFIER,
		"x-grok-client-version": GROK_CLIENT_VERSION,
		"x-grok-client-mode": "interactive",
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-authenticateresponse": "authenticate-response",
	};
	if (modelId) headers["x-grok-model-override"] = modelId;
	return headers;
}

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
		id: "grok-4.6",
		name: "Grok 4.6",
		reasoning: true,
		input: ["text", "image"],
		// grok-4.6 is priced the same as grok-4.5; context_window mirrors the
		// cli-chat-proxy /models entry. The proxy does not publish
		// max_output_tokens, so 128k mirrors grok-4.5.
		cost: COST_45,
		contextWindow: 500_000,
		maxTokens: 131_072,
	},
	{
		id: "grok-4.5",
		name: "Grok 4.5",
		reasoning: true,
		input: ["text", "image"],
		cost: COST_45,
		contextWindow: 500_000,
		maxTokens: 131_072,
	},
	{
		id: "grok-4.3",
		name: "Grok 4.3",
		reasoning: true,
		input: ["text", "image"],
		cost: COST_43,
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	},
	{
		id: "grok-4.20-0309-reasoning",
		name: "Grok 4.20 Reasoning",
		reasoning: true,
		input: ["text", "image"],
		cost: COST_420,
		contextWindow: 2_000_000,
		maxTokens: 131_072,
	},
	{
		id: "grok-4.20-0309-non-reasoning",
		name: "Grok 4.20 Non-Reasoning",
		reasoning: false,
		input: ["text", "image"],
		cost: COST_420,
		contextWindow: 2_000_000,
		maxTokens: 131_072,
	},
	{
		id: "grok-4.20-multi-agent-0309",
		name: "Grok 4.20 Multi-Agent",
		reasoning: true,
		input: ["text", "image"],
		cost: COST_420,
		contextWindow: 2_000_000,
		maxTokens: 131_072,
	},
];

// ─── Reasoning-effort allowlist ───────────────────────────────────────────────

/**
 * Only these model prefixes support `reasoning.effort` in the Responses API.
 * Everything else gets the param stripped in the sanitizer.
 */
const EFFORT_CAPABLE_PREFIXES = ["grok-3-mini", "grok-4.20-multi-agent", "grok-4.3", "grok-4.5", "grok-4.6"];

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
function envModelIds(): string[] {
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
	name?: string;
	owned_by?: string;
	/** cli-chat-proxy field. OpenAI-shaped catalogs send `context_length`. */
	context_window?: number;
	context_length?: number;
	max_output_tokens?: number;
	supports_reasoning_effort?: boolean;
}

/** Live catalog window: proxy uses context_window; OpenAI uses context_length. */
function liveContextWindow(entry: ApiModelEntry): number | undefined {
	return entry.context_window ?? entry.context_length;
}

/** Effort map from a live entry. The proxy flag wins over the prefix list so a
 * newly released id does not wait for a code change to expose the picker. */
function liveThinkingMap(
	entry: ApiModelEntry,
	reasoning: boolean,
): Record<string, string | null> | undefined {
	if (entry.supports_reasoning_effort) {
		return { off: null, minimal: null, xhigh: "xhigh" };
	}
	return thinkingLevelMapFor(entry.id, reasoning);
}

/** Cost overrides for known model families (the live API doesn't expose pricing). */
const COST_OVERRIDES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
	"grok-build": COST_BUILD,
	"grok-4.3": COST_43,
	"grok-4.5": COST_45,
	"grok-4.6": COST_45,
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
 * This is enrichment only: the live catalog is authoritative for the
 * context window (`context_window` on the proxy, `context_length` on an
 * OpenAI-shaped body) and `max_output_tokens` when present. The merged
 * list follows the live response order, and newly discovered ids get
 * sensible defaults. It does not set routing. `rebuildModelsForOAuth` is
 * the single routing authority and sends every OAuth model through the
 * CLI proxy, so merge stays decoupled from how requests reach xAI.
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
			// Live fields override; base fills cost/reasoning when the proxy
			// does not send them. Name and effort map come from the live
			// entry when present so a renamed or newly effort-capable id
			// does not wait for a fallback edit.
			const reasoning = existing.reasoning;
			const thinkingLevelMap = liveThinkingMap(entry, reasoning)
				?? existing.thinkingLevelMap;
			merged.push({
				...existing,
				name: entry.name ?? existing.name,
				contextWindow: liveContextWindow(entry) ?? existing.contextWindow,
				maxTokens: entry.max_output_tokens ?? existing.maxTokens,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			});
		} else {
			const reasoning = true;
			const thinkingLevelMap = liveThinkingMap(entry, reasoning);
			merged.push({
				id: entry.id,
				name: entry.name ?? entry.id,
				reasoning,
				input: ["text", "image"],
				cost: COST_OVERRIDES[entry.id] ?? COST_420,
				contextWindow: liveContextWindow(entry) ?? 1_000_000,
				maxTokens: entry.max_output_tokens ?? 30_000,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
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

/** Reject a live `/models` body larger than this before parsing. */
const CATALOG_MAX_RESPONSE_BYTES = 256 * 1024;

/** Outcome of one `/models` request. `retryable` is false for auth and
 * client errors (401/403/4xx other than 408/429); true for 5xx, 408, 429,
 * timeouts, and network failures. */
type CatalogFetchResult =
	| { ok: true; body: { data?: ApiModelEntry[] } }
	| { ok: false; retryable: boolean; error: string };

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

/** Fetch the raw `/models` body. Never throws: every failure is a typed result. */
async function fetchLiveCatalog(
	accessToken: string,
	baseUrl: string,
): Promise<CatalogFetchResult> {
	try {
		const response = await safeFetch(`${baseUrl}/models`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				...buildProxyHeaders(),
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			return {
				ok: false,
				retryable: isRetryableStatus(response.status),
				error: `catalog fetch failed (${response.status})`,
			};
		}
		// readBoundedJson streams the body through the byte cap and the bounded
		// walker in one pass, so a pathological response can't exhaust memory
		// before the post-hoc length check fires.
		const parsed = await readBoundedJson(response, CATALOG_MAX_RESPONSE_BYTES, CATALOG_BOUNDED_JSON_OPTIONS);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { ok: false, retryable: true, error: "catalog fetch failed (invalid body)" };
		}
		return { ok: true, body: parsed as { data?: ApiModelEntry[] } };
	} catch (err) {
		if (err instanceof RedirectError) {
			return { ok: false, retryable: false, error: "catalog fetch failed (redirect)" };
		}
		const name = err instanceof Error ? err.name : "";
		if (name === "TimeoutError" || name === "AbortError") {
			return { ok: false, retryable: true, error: "catalog fetch failed (timeout)" };
		}
		return { ok: false, retryable: true, error: "catalog fetch failed (network)" };
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
let discoveryLoadedFromDisk = false; // true after the first attempt to read the disk cache

/** Backoff between retries after a transient failure. Three delays = four
 * attempts total (initial + one per delay). Overridable in tests. */
const DISCOVERY_RETRY_DELAYS_MS = [10_000, 30_000, 90_000];
let discoveryRetryDelaysMs = DISCOVERY_RETRY_DELAYS_MS;
let discoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
let discoveryRetryWaitResolve: (() => void) | null = null;

/** Called after a successful live fetch commits a body. The host uses this
 * to re-register the provider so the picker updates without a second open. */
type CatalogUpdatedHandler = (body: { data?: ApiModelEntry[] }) => void;
let catalogUpdatedHandler: CatalogUpdatedHandler | null = null;

export function onCatalogUpdated(handler: CatalogUpdatedHandler | null): void {
	catalogUpdatedHandler = handler;
}

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
 * A transient failure (5xx, 408, 429, timeout, network) retries with
 * backoff (10s / 30s / 90s, four attempts total). Auth and other 4xx
 * failures stop at the first attempt. A later trigger (picker, /reload,
 * /login) after the budget is spent starts a fresh sequence.
 */
export function triggerDiscovery(accessToken: string, baseUrl: string): void {
	// Drop a second trigger only when one is in flight for the same token. A
	// token change (re-login, refresh) means the cached body may belong to a
	// different session, so start a fresh fetch.
	//
	// A superseded fetch (for an older token) must not overwrite the cache or
	// clear the in-flight flag while the newer one runs: the worker captures its
	// token and skips committing once discoveryLastToken has moved on, and only
	// the promise that is still current clears discoveryInFlight (identity
	// check, run from a chained finally so the worker never self-references).
	if (discoveryInFlight && discoveryLastToken === accessToken) return;

	// Same token, a successful body younger than the fresh TTL, no error:
	// skip the network. The picker and /xai-status both call this, and a
	// 15-minute-old catalog does not need another /models hit.
	if (
		discoveryLastToken === accessToken
		&& discoveredBody
		&& discoveryFetchedAt > 0
		&& Date.now() - discoveryFetchedAt < CATALOG_FRESH_TTL_MS
		&& discoveryLastError === null
	) {
		return;
	}

	// Stamp the new token first so a worker woken from a retry delay sees it
	// and exits instead of firing another request for the old token.
	discoveryLastToken = accessToken;
	cancelPendingRetryWait();

	// On the first trigger, adopt the on-disk cache as the initial in-memory
	// state before issuing the network request. The first cold pi start
	// otherwise shows the hardcoded fallback list until the fetch resolves;
	// seeding from disk surfaces context windows and newly released ids at
	// once. A stale disk cache is adopted here (the fetch below refreshes it);
	// an expired or missing disk cache is a no-op.
	const seed = discoveryLoadedFromDisk
		? Promise.resolve()
		: (() => {
			discoveryLoadedFromDisk = true;
			return loadCatalogFromDisk();
		})();
	const myToken = accessToken;
	const p: Promise<void> = (async () => {
		await seed; // never overwrite an in-memory state the disk load hasn't seen
		for (let attempt = 0; ; attempt++) {
			const result = await fetchLiveCatalog(accessToken, baseUrl);
			if (discoveryLastToken !== myToken) return; // superseded by a newer token
			if (result.ok && Array.isArray(result.body.data) && result.body.data.length > 0) {
				discoveredBody = result.body;
				discoveryLastError = null;
				discoveryFetchedAt = Date.now();
				void writeCachedCatalog(catalogCachePath, result.body, discoveryFetchedAt);
				if (catalogUpdatedHandler) {
					try { catalogUpdatedHandler(result.body); }
					catch { /* host callback must not break the worker */ }
				}
				return;
			}
			const error = result.ok
				? (Array.isArray(result.body.data)
					? "catalog fetch failed (empty catalog)"
					: "catalog fetch failed (invalid body)")
				: result.error;
			discoveryLastError = error;
			const retryable = result.ok || result.retryable;
			if (!retryable) return;
			const delay = discoveryRetryDelaysMs[attempt];
			if (delay === undefined) return;
			const total = discoveryRetryDelaysMs.length + 1;
			discoveryLastError = `${error}; retrying ${attempt + 2}/${total}`;
			await waitForRetry(delay);
			if (discoveryLastToken !== myToken) return;
		}
	})();
	discoveryInFlight = p;
	p.finally(() => {
		if (discoveryInFlight === p) discoveryInFlight = null;
	});
}

/** Resolve after `ms`, or sooner if a newer trigger cancels the wait. */
function waitForRetry(ms: number): Promise<void> {
	return new Promise((resolve) => {
		discoveryRetryWaitResolve = resolve;
		discoveryRetryTimer = setTimeout(() => {
			discoveryRetryTimer = null;
			discoveryRetryWaitResolve = null;
			resolve();
		}, ms);
	});
}

/** Wake a worker parked on a retry delay so a newer token can take over. */
function cancelPendingRetryWait(): void {
	if (discoveryRetryTimer) {
		clearTimeout(discoveryRetryTimer);
		discoveryRetryTimer = null;
	}
	if (discoveryRetryWaitResolve) {
		const resolve = discoveryRetryWaitResolve;
		discoveryRetryWaitResolve = null;
		resolve();
	}
}

/** Read the on-disk cache and adopt it as the in-memory state when it is
 * fresh or stale-but-not-expired. Failures (missing file, parse error, expired)
 * are swallowed: the caller still has the hardcoded fallback list to work
 * with, and the next network fetch will overwrite whatever we adopted. */
async function loadCatalogFromDisk(): Promise<void> {
	if (!catalogCachePath) return;
	let text: string;
	try {
		text = await readFile(catalogCachePath, "utf8");
	} catch {
		return; // missing or unreadable: silently use the fallback list
	}
	const loaded = loadCachedCatalog(text, {
		fetchedAt: discoveryFetchedAt,
		now: Date.now(),
	});
	if (!loaded) return;
	if (!isCatalogBody(loaded.body)) return;
	discoveredBody = loaded.body;
	if (loaded.source === "stale-cache") {
		// Surfacing stale data while the network refresh runs; flag the state
		// so /xai-status can show why the catalog looks older than expected.
		discoveryLastError = "cache stale; refreshing";
	}
}

/** Narrows an unknown disk-cached body to the catalog shape mergeLiveModels expects. */
function isCatalogBody(body: unknown): body is { data?: ApiModelEntry[] } {
	return !!body && typeof body === "object" && !Array.isArray(body);
}

/** Snapshot of the discovery cache for `/xai-status`. `cold` means no
 * successful fetch has completed yet; `in-flight` means one is running;
 * `warm` means the cache holds a catalog body. `modelCount` is the count of
 * chat-model ids (the non-chat entries the proxy lists are filtered out at
 * merge time, so this matches what the picker shows, not the raw list length). */
export function discoveryStatus(): {
	state: "cold" | "in-flight" | "warm";
	modelCount: number;
	fetchedAt: number;
	lastError: string | null;
} {
	let state: "cold" | "in-flight" | "warm";
	if (discoveryInFlight) state = "in-flight";
	else if (discoveredBody) state = "warm";
	else state = "cold";
	const chatCount = discoveredBody?.data?.filter((e) => isChatModelEntry(e.id)).length ?? 0;
	return {
		state,
		modelCount: chatCount,
		fetchedAt: discoveryFetchedAt,
		lastError: discoveryLastError,
	};
}

/** Clear the discovery cache. For tests only. */
export function resetDiscoveryForTests(): void {
	// Null the token first so a worker woken from a retry delay exits instead
	// of firing another request against a restored fetch mock.
	discoveryLastToken = null;
	cancelPendingRetryWait();
	discoveredBody = null;
	discoveryInFlight = null;
	discoveryLastError = null;
	discoveryFetchedAt = 0;
	discoveryLoadedFromDisk = false;
	discoveryRetryDelaysMs = DISCOVERY_RETRY_DELAYS_MS;
	catalogUpdatedHandler = null;
}

/** Override the retry backoff for tests. Pass an empty array to disable
 * retries (one attempt only). Restored by resetDiscoveryForTests. */
export function _setDiscoveryRetryDelaysForTests(delaysMs: number[]): void {
	discoveryRetryDelaysMs = delaysMs;
}

/** Override the cache path (and reset the loaded-from-disk flag) for tests.
 * Pass an empty string to disable disk caching entirely. */
export function _setCatalogCachePathForTests(path: string): void {
	catalogCachePath = path;
	discoveryLoadedFromDisk = false;
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
			headers: buildProxyHeaders(row.id),
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		};
	});

	return [...others, ...merged];
}

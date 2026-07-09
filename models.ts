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
const CLI_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
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

// ─── Live catalog fetch ───────────────────────────────────────────────────────

interface ApiModelEntry {
	id: string;
	owned_by?: string;
	context_length?: number;
	max_output_tokens?: number;
}

/** Cost overrides for known model families (live API doesn't expose pricing). */
const COST_OVERRIDES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
	"grok-build": COST_BUILD,
	"grok-4.3": COST_43,
	"grok-4.5": COST_45,
};

export async function fetchLiveModels(
	accessToken: string,
	baseUrl: string,
): Promise<XaiModelConfig[] | null> {
	try {
		const response = await fetch(`${baseUrl}/models`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"x-grok-client-version": CLI_PROXY_HEADERS["x-grok-client-version"],
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return null;

		const body = (await response.json()) as { data?: ApiModelEntry[] };
		const entries = body.data;
		if (!Array.isArray(entries)) return null;

		// Only keep Grok models (not embedding, tts, etc.)
		const grokEntries = entries.filter((e) => e.id.startsWith("grok"));

		// Merge: prefer fallback metadata (cost, reasoning) but include
		// newly-discovered models not in the fallback list.
		const fallbackById = new Map(FALLBACK_MODELS.map((m) => [m.id, m]));
		const seen = new Set<string>();
		const merged: XaiModelConfig[] = [];

		for (const entry of grokEntries) {
			seen.add(entry.id);
			const existing = fallbackById.get(entry.id);
			if (existing) {
				merged.push(existing);
			} else {
				merged.push({
					id: entry.id,
					name: entry.id,
					reasoning: true,
					input: ["text", "image"],
					cost: COST_OVERRIDES[entry.id] ?? COST_420,
					contextWindow: entry.context_length ?? 1_000_000,
					maxTokens: entry.max_output_tokens ?? 30_000,
					// Models only on the CLI proxy need its base URL + version header.
					baseUrl: CLI_PROXY_BASE_URL,
					headers: CLI_PROXY_HEADERS,
				});
			}
		}

		// Append fallback models not seen in the live response.
		for (const fb of FALLBACK_MODELS) {
			if (!seen.has(fb.id)) merged.push(fb);
		}

		return merged;
	} catch {
		return null;
	}
}

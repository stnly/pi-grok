/**
 * pi-grok — xAI Grok OAuth provider for pi
 *
 * Brings SuperGrok / Premium subscription access (including Grok Build)
 * into pi via the official xAI OAuth 2.0 + PKCE flow.
 *
 * Based on the Hermes agent xai-oauth implementation, rewritten for the pi SDK.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type SimpleStreamOptions,
	streamSimpleOpenAIResponses,
} from "@earendil-works/pi-ai";
import * as oauth from "./oauth.js";
import { type XaiOAuthCredentials, getBaseUrl } from "./oauth.js";
import {
	resolveModels,
	mergeDiscoveredModels,
	triggerDiscovery,
	type XaiModelConfig,
} from "./models.js";
import { sanitizePayload } from "./sanitize.js";
import { XaiOAuthError } from "./errors.js";
import { registerXSearchTool } from "./x-search-tool.js";

// ─── Stream function ─────────────────────────────────────────────────────────

function streamGrok(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const sessionId = options?.sessionId;
	const headers = {
		...options?.headers,
		...(sessionId ? { "x-grok-conv-id": sessionId } : {}),
	};

	return streamSimpleOpenAIResponses(model as Model<"openai-responses">, context, {
		...options,
		headers,
	});
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const baseUrl = getBaseUrl();
	const models = resolveModels();

	// ── Register provider ─────────────────────────────────────────────────
	pi.registerProvider("xai-oauth", {
		name: "xAI (SuperGrok Subscription)",
		baseUrl,
		apiKey: "$XAI_OAUTH_TOKEN",
		api: "openai-responses",
		models: models.map((m: XaiModelConfig) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			thinkingLevelMap: m.thinkingLevelMap,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
			...(m.headers ? { headers: m.headers } : {}),
		})),
		oauth: {
			name: "xAI (SuperGrok Subscription)",
			usesCallbackServer: true,

			async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
				return oauth.login(callbacks);
			},

			async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
				return oauth.refresh(credentials);
			},

			getApiKey(credentials: OAuthCredentials): string {
				return credentials.access;
			},

			modifyModels(models: unknown, credentials: unknown) {
				const creds = credentials as XaiOAuthCredentials;
				const effectiveBaseUrl = String(creds.baseUrl ?? getBaseUrl()).replace(/\/+$/, "");

				// Kick off a background live-catalog fetch. modifyModels runs
				// synchronously, so the cache populates after this call returns;
				// the next model load picks up discovered models.
				if (creds.access) triggerDiscovery(creds.access, effectiveBaseUrl);

				const all = models as Array<Record<string, unknown>>;
				// Extract our provider's models, merge the discovered catalog into
				// them, then write them back over the full list.
				const ours = all.filter((m) => m.provider === "xai-oauth");
				const merged: XaiModelConfig[] = mergeDiscoveredModels(
					ours as unknown as XaiModelConfig[],
				).map((m: XaiModelConfig) => ({
					...m,
					baseUrl: m.baseUrl ?? effectiveBaseUrl,
				}));
				const mergedById = new Map(merged.map((m) => [m.id, m]));

				return all.map((m) =>
					m.provider === "xai-oauth" ? (mergedById.get(m.id as string) ?? m) : m,
				);
			},
		} as any,

		streamSimple: streamGrok,
	});

	// ── Payload sanitization via event ────────────────────────────────────
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "xai-oauth") return;

		const modelId = ctx.model?.id ?? "";
		const sessionId = ctx.sessionManager?.getSessionId();
		return sanitizePayload(event.payload as Record<string, unknown>, modelId, sessionId);
	});

	// ── X Search tool ─────────────────────────────────────────────────────
	if ((process.env.PI_XAI_X_SEARCH ?? "true").toLowerCase() !== "false") {
		registerXSearchTool(pi);
	}

	// ── /xai-status command ───────────────────────────────────────────────
	pi.registerCommand("xai-status", {
		description: "Show xAI Grok OAuth status and token health",
		handler: async (_args, ctx) => {
			const token = process.env.XAI_OAUTH_TOKEN;
			if (token) {
				ctx.ui.notify(
					"⚠️  xAI: using XAI_OAUTH_TOKEN env bypass — no auto-refresh available",
					"warning",
				);
				return;
			}

			// Check if OAuth credentials exist by trying to resolve the provider
			try {
				const registry = ctx.modelRegistry;
				const grokModels = registry.getAll().filter((m: Model<Api>) => m.provider === "xai-oauth");
				if (grokModels.length === 0) {
					ctx.ui.notify("xAI: no models registered. Run /login xai-oauth first.", "warning");
					return;
				}

				const modelNames = grokModels.slice(0, 5).map((m: Model<Api>) => m.id).join(", ");
				const suffix = grokModels.length > 5 ? ` (+${grokModels.length - 5} more)` : "";
				ctx.ui.notify(
					`✓ xAI Grok OAuth: ${grokModels.length} models available (${modelNames}${suffix})`,
					"info",
				);
			} catch (err) {
				const msg = err instanceof XaiOAuthError
					? `${err.message} (code: ${err.code})`
					: err instanceof Error
						? err.message
						: String(err);
				ctx.ui.notify(`xAI: ${msg}`, "warning");
			}
		},
	});

	// ── Warn on env bypass ────────────────────────────────────────────────
	if (process.env.XAI_OAUTH_TOKEN) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(
				"[pi-grok] Using XAI_OAUTH_TOKEN bypass — no auto-refresh, no model discovery",
				"warning",
			);
		});
	}
}

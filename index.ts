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
	rebuildModelsForOAuth,
	triggerDiscovery,
	type XaiModelConfig,
} from "./models.js";
import {
	fetchUser,
	formatStatusBlock,
	parsePrivacyArg,
	privacyLine,
	privacyUsage,
	setCodingDataRetention,
} from "./account.js";
import { runPrivacyPicker } from "./privacy.js";
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

				// Full rebuild: append discovered ids, re-apply PI_XAI_OAUTH_MODELS,
				// stamp api/provider, keep CLI-proxy baseUrls and fill public ones.
				return rebuildModelsForOAuth(
					models as Array<Record<string, unknown>>,
					"xai-oauth",
					effectiveBaseUrl,
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
		description: "Show xAI Grok account, privacy, and model status",
		handler: async (_args, ctx) => {
			const grokModels = ctx.modelRegistry.getAll().filter((m: Model<Api>) => m.provider === "xai-oauth");

			// Resolve the live access token. Handles both the OAuth path and the
			// XAI_OAUTH_TOKEN env bypass; missing token means not logged in.
			let token: string | undefined;
			try {
				token = await ctx.modelRegistry.getApiKeyForProvider("xai-oauth");
			} catch {
				token = undefined;
			}

			const tokenSource = process.env.XAI_OAUTH_TOKEN
				? "env"
				: token
					? "oauth"
					: "none";

			// Fetch account enrichment best-effort: a failed lookup (offline,
			// expired) still renders the model count so status stays useful.
			let user = null;
			if (token) {
				try {
					user = await fetchUser(token);
				} catch (err) {
					const msg = err instanceof XaiOAuthError ? `${err.message} (code: ${err.code})` : err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`xAI account lookup failed: ${msg}`, "warning");
				}
			}

			ctx.ui.notify(
				formatStatusBlock({ user, modelCount: grokModels.length, tokenSource }),
				"info",
			);
		},
	});

	// ── /xai-privacy command ──────────────────────────────────────────────
	pi.registerCommand("xai-privacy", {
		description: "Show or set xAI coding data retention (privacy mode)",
		handler: async (args, ctx) => {
			let token: string | undefined;
			try {
				token = await ctx.modelRegistry.getApiKeyForProvider("xai-oauth");
			} catch {
				token = undefined;
			}
			if (!token) {
				ctx.ui.notify("xAI: not logged in. Run /login, choose xAI (SuperGrok Subscription).", "warning");
				return;
			}

			const parsed = parsePrivacyArg(args);
			if (parsed.kind === "invalid") {
				ctx.ui.notify(`Unknown argument \`${parsed.arg}\`. ${privacyUsage()}`, "warning");
				return;
			}

			// Read current state. The /user fetch also surfaces isZdr when the
			// org locks retention; if it does, the picker is moot.
			let user;
			try {
				user = await fetchUser(token);
			} catch (err) {
				const msg = err instanceof XaiOAuthError ? `${err.message} (code: ${err.code})` : err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`xAI privacy: ${msg}`, "warning");
				return;
			}
			if (user.isZdr) {
				ctx.ui.notify(`xAI privacy: ${privacyLine(user)}`, "info");
				return;
			}

			// No argument: show an inline themed picker with both modes and a
			// green tick on the current one (mirrors the login provider
			// selector, rendered inline like /login, not as a popup). An explicit
			// alias skips the picker and applies.
			let target: boolean;
			if (parsed.kind === "select") {
				if (!ctx.hasUI) return; // non-interactive: nothing to pick
				const picked = await runPrivacyPicker(ctx.ui, user.codingDataRetentionOptOut);
				if (picked === undefined) return; // cancelled
				target = picked;
			} else {
				target = parsed.optOut;
			}

			// Nothing to do if the account is already in the picked mode.
			if (target === user.codingDataRetentionOptOut) {
				ctx.ui.notify(`xAI privacy: ${privacyLine(user)} (no change)`, "info");
				return;
			}

			try {
				const applied = await setCodingDataRetention(token, target);
				ctx.ui.notify(
					`xAI privacy: ${privacyLine({ codingDataRetentionOptOut: applied })}`,
					"info",
				);
			} catch (err) {
				const msg = err instanceof XaiOAuthError ? `${err.message} (code: ${err.code})` : err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`xAI privacy: ${msg}`, "warning");
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

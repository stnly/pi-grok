/**
 * pi-grok: xAI Grok OAuth provider for pi
 *
 * Brings SuperGrok / Premium subscription access (including Grok Build)
 * into pi via the official xAI OAuth 2.0 + PKCE flow.
 *
 * Based on the Hermes agent xai-oauth implementation, rewritten for the pi SDK.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	RefreshModelsContext,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import * as oauth from "./oauth.js";
import { type XaiOAuthCredentials, getBaseUrl } from "./oauth.js";
import {
	resolveModels,
	rebuildModelsForOAuth,
	applyDiscoveredModels,
	thinkingLevelMapFor,
	triggerDiscovery,
	refreshCatalogNow,
	discoveryStatus,
	onCatalogUpdated,
	CLI_PROXY_BASE_URL,
	buildProxyHeaders,
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
import { loadStreamOpenAIResponses } from "./streamer.js";
import { XaiOAuthError } from "./errors.js";
import { registerXSearchTool } from "./x-search-tool.js";
import { fetchUsage, formatUsageBlock, XaiUsageError } from "./usage.js";

// Which specifier carries the responses streamer depends on the host's alias
// table, not on pi-ai's version, so the probe lives in streamer.ts and picks the
// first layout that works. Top-level await: it resolves before the factory runs.
const streamSimpleOpenAIResponses = await loadStreamOpenAIResponses();

function streamGrok(
	model: Model<Api>,
	// pi-ai 0.86 narrowed the provider stream input from `Context` to
	// `TranscriptContext`. Both are `{ messages }` at runtime and the streamer
	// only reads `context.messages`, so the wider `Context` type keeps this
	// assignable to `streamSimple` on hosts from either side of the change.
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const sessionId = options?.sessionId;
	// The headers stored on the model were built once, at provider
	// registration, so their client version goes stale for the rest of the
	// session. Rebuild the version-bearing headers per request; the streamer
	// spreads options.headers over model.headers, so these win.
	const fresh = buildProxyHeaders(model.id);
	const headers = {
		...options?.headers,
		"User-Agent": fresh["User-Agent"],
		"x-grok-client-version": fresh["x-grok-client-version"],
		...(sessionId ? { "x-grok-conv-id": sessionId } : {}),
	};

	return streamSimpleOpenAIResponses(model as Model<"openai-responses">, context, {
		...options,
		headers,
	});
}

/**
 * Format a proxy/account error for display. A `reloginRequired` error means
 * the access token is bad or expired, so skip the raw dump and point at /login.
 */
function formatProxyError(err: unknown, prefix: string): string {
	if (err instanceof XaiOAuthError) {
		if (err.reloginRequired) return "xAI session expired. Run /login to re-authenticate.";
		return `${prefix}: ${err.message} (code: ${err.code})`;
	}
	const msg = err instanceof Error ? err.message : String(err);
	return `${prefix}: ${msg}`;
}

export default function (pi: ExtensionAPI) {
	const baseUrl = getBaseUrl();
	const models = resolveModels();

	// `usesCallbackServer` selects the host's loopback-callback login path over
	// manual paste. It is read at runtime but is absent from the published oauth
	// config type, so the oauth block is built as a variable of this type (excess
	// properties are allowed for variables, not literals) and handed to the host.
	type XaiOAuthConfig = Parameters<ExtensionAPI["registerProvider"]>[1] extends
		{ oauth?: infer O } ? O & { usesCallbackServer: boolean } : never;
	const oauthConfig: XaiOAuthConfig = {
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

		modifyModels(models: Model<Api>[], credentials: OAuthCredentials) {
			const creds = credentials as XaiOAuthCredentials;

			// Kick off a background live-catalog fetch for enrichment (context
			// windows, newly released ids). The OAuth session's model registry
			// lives on the cli-chat-proxy, so discovery rides the proxy with
			// the proxy identity headers, never api.x.ai. Routing of individual
			// models is static and set in rebuildModelsForOAuth below.
			if (creds.access) triggerDiscovery(creds.access, CLI_PROXY_BASE_URL);

			// Full rebuild: append discovered ids, re-apply PI_XAI_OAUTH_MODELS,
			// stamp api/provider, and route every model through the CLI proxy.
			// rebuildModelsForOAuth is typed loosely (Record<string, unknown>[])
			// because it rewrites provider entries generically; the result keeps
			// the Model shape the host handed in, so cast back at the boundary.
			return rebuildModelsForOAuth(
				models as unknown as Array<Record<string, unknown>>,
				"xai-oauth",
			) as unknown as Model<Api>[];
		},
	};

	const toProviderModels = (list: XaiModelConfig[]) => list.map((m) => ({
		id: m.id,
		name: m.name,
		reasoning: m.reasoning,
		thinkingLevelMap: m.thinkingLevelMap ?? thinkingLevelMapFor(m.id, m.reasoning),
		input: m.input,
		cost: m.cost,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		// Stamp proxy routing at registration so the XAI_OAUTH_TOKEN env
		// bypass (which skips modifyModels) rides the proxy too. The OAuth
		// path re-stamps this in rebuildModelsForOAuth, including discovered
		// ids the registration map never saw.
		baseUrl: CLI_PROXY_BASE_URL,
		headers: buildProxyHeaders(m.id),
	}));

	// `/model` calls modelRuntime.refresh(), which awaits this and publishes
	// the returned list before the picker redraws. Fetch even inside the
	// discovery TTL; opening the picker is an explicit refresh.
	const refreshModels = async (context: RefreshModelsContext) => {
		if (!context.allowNetwork || context.signal.aborted) return toProviderModels(applyDiscoveredModels(resolveModels()));
		const token = context.credential?.type === "oauth"
			? context.credential.access
			: process.env.XAI_OAUTH_TOKEN;
		if (!token) return toProviderModels(applyDiscoveredModels(resolveModels()));
		return toProviderModels(await refreshCatalogNow(token, context.signal));
	};

	// The provider config is registered twice: once at load, and again whenever a
	// live catalog fetch lands so the picker picks up new ids and context windows
	// without a second open. Both sites go through this helper so the two can
	// never drift — the re-registration is what a running session actually runs
	// with, so a field added to only one of them would silently disappear.
	const registerXaiProvider = (list: XaiModelConfig[]) => {
		pi.registerProvider("xai-oauth", {
			name: "xAI (SuperGrok Subscription)",
			baseUrl,
			apiKey: "$XAI_OAUTH_TOKEN",
			api: "openai-responses",
			models: toProviderModels(list),
			oauth: oauthConfig,
			refreshModels,
			streamSimple: streamGrok,
		});
	};

	registerXaiProvider(models);

	// Re-register on catalog updates. registerProvider after load takes effect
	// immediately and re-runs modifyModels, which calls triggerDiscovery again;
	// that call is a no-op (in-flight or still inside the fresh TTL).
	onCatalogUpdated(() => {
		registerXaiProvider(applyDiscoveredModels(resolveModels()));
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "xai-oauth") return;

		const modelId = ctx.model?.id ?? "";
		const sessionId = ctx.sessionManager?.getSessionId();
		return sanitizePayload(event.payload as Record<string, unknown>, modelId, sessionId, ctx.model?.reasoning ?? false);
	});

	if ((process.env.PI_XAI_X_SEARCH ?? "true").toLowerCase() !== "false") {
		registerXSearchTool(pi);
	}

	pi.registerCommand("xai-status", {
		description: "Show xAI Grok account, privacy, and model status",
		handler: async (_args, ctx) => {
			const grokModels = ctx.modelRegistry.getAll().filter((m: Model<Api>) => m.provider === "xai-oauth");

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
			// Kick discovery too: /xai-status is the command you run when the
			// catalog looks stale, and after the retry budget is spent this is
			// the way to start a fresh sequence. A fetch already in flight for
			// this token is a no-op.
			let user = null;
			if (token) {
				triggerDiscovery(token, CLI_PROXY_BASE_URL);
				try {
					user = await fetchUser(token);
				} catch (err) {
					ctx.ui.notify(formatProxyError(err, "xAI account lookup failed"), "warning");
				}
			}

			ctx.ui.notify(
				formatStatusBlock({ user, modelCount: grokModels.length, tokenSource, discovery: discoveryStatus() }),
				"info",
			);
		},
	});

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
				ctx.ui.notify(formatProxyError(err, "xAI privacy"), "warning");
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
				ctx.ui.notify(formatProxyError(err, "xAI privacy"), "warning");
			}
		},
	});

	pi.registerCommand("xai-usage", {
		description: "Show xAI subscription credit usage",
		handler: async (_args, ctx) => {
			let token: string | undefined;
			try {
				token = await ctx.modelRegistry.getApiKeyForProvider("xai-oauth");
			} catch {
				token = undefined;
			}
			if (!token) {
				ctx.ui.notify(
					"xAI: not logged in. Run /login, choose xAI (SuperGrok Subscription).",
					"warning",
				);
				return;
			}

			try {
				const snapshot = await fetchUsage(token);
				ctx.ui.notify(formatUsageBlock(snapshot), "info");
			} catch (err) {
				const message = err instanceof XaiUsageError
					? err.message
					: `xAI usage lookup failed: ${err instanceof Error ? err.message : String(err)}`;
				ctx.ui.notify(message, "warning");
			}
		},
	});

	if (process.env.XAI_OAUTH_TOKEN) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(
				"[pi-grok] Using XAI_OAUTH_TOKEN bypass: no auto-refresh, no model discovery",
				"warning",
			);
		});
	}
}

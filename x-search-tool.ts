/**
 * x_search tool — proxy xAI's built-in X Search via a separate API call.
 *
 * When the model calls this tool, we make an independent request to xAI's
 * Responses API with the server-side x_search tool. This means:
 *
 *   - Any model (not just Grok) can search X
 *   - The search call uses a dedicated model with full x_search support
 *   - Results come back as structured tool output visible in pi's UI
 *   - Per-query parameters (handles, date ranges) are supported
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── Config ──────────────────────────────────────────────────────────────────

const SEARCH_MODEL = process.env.PI_XAI_X_SEARCH_MODEL ?? "grok-4.3";

// ─── Types ───────────────────────────────────────────────────────────────────

interface XSearchResult {
	answer: string;
	citations?: Array<{ url: string; title?: string }>;
}

// ─── API call ────────────────────────────────────────────────────────────────

async function callXSearch(
	apiKey: string,
	baseUrl: string,
	query: string,
	options?: {
		allowedXHandles?: string[];
		excludedXHandles?: string[];
		fromDate?: string;
		toDate?: string;
		enableImageUnderstanding?: boolean;
		enableVideoUnderstanding?: boolean;
	},
	signal?: AbortSignal,
): Promise<XSearchResult> {
	const xSearchTool: Record<string, unknown> = { type: "x_search" };
	if (options?.allowedXHandles?.length) xSearchTool.allowed_x_handles = options.allowedXHandles;
	if (options?.excludedXHandles?.length) xSearchTool.excluded_x_handles = options.excludedXHandles;
	if (options?.fromDate) xSearchTool.from_date = options.fromDate;
	if (options?.toDate) xSearchTool.to_date = options.toDate;
	if (options?.enableImageUnderstanding) xSearchTool.enable_image_understanding = true;
	if (options?.enableVideoUnderstanding) xSearchTool.enable_video_understanding = true;

	const payload = {
		model: SEARCH_MODEL,
		input: [{ role: "user", content: query }],
		tools: [xSearchTool],
		store: false,
	};

	const response = await fetch(`${baseUrl}/responses`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(payload),
		signal,
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`xAI x_search failed (${response.status}): ${body.slice(0, 500)}`);
	}

	const data = await response.json();

	// Extract text from the Responses API output
	const outputItems: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> =
		data.output ?? [];
	const textParts: string[] = [];
	for (const item of outputItems) {
		if (item.type === "message" && Array.isArray(item.content)) {
			for (const part of item.content) {
				if (part.type === "output_text" && part.text) {
					textParts.push(part.text);
				}
			}
		}
	}

	const citations: XSearchResult["citations"] = [];
	if (Array.isArray(data.citations)) {
		for (const c of data.citations) {
			if (c.url) citations.push({ url: c.url, title: c.title });
		}
	}

	return {
		answer: textParts.join("\n") || "(no results)",
		citations: citations.length > 0 ? citations : undefined,
	};
}

// ─── Tool registration ───────────────────────────────────────────────────────

export function registerXSearchTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "x_search",
		label: "X Search",
		description:
			"Search X (formerly Twitter) for posts, users, and threads. "
			+ "Returns relevant posts and their content. Use this when you need "
			+ "real-time social media information, public sentiment, or to find "
			+ "specific posts by keyword, topic, or user.",
		promptSnippet: "Search X (Twitter) for posts and users",
		parameters: Type.Object({
			query: Type.String({
				description: "Search query — keywords, hashtags, or natural language description of what to find",
			}),
			allowed_x_handles: Type.Optional(
				Type.Array(Type.String(), {
					description: "Only include posts from these X handles (max 10)",
				}),
			),
			excluded_x_handles: Type.Optional(
				Type.Array(Type.String(), {
					description: "Exclude posts from these X handles (max 10)",
				}),
			),
			from_date: Type.Optional(
				Type.String({
					description: 'Start date for search range (ISO 8601, e.g. "2025-01-01")',
				}),
			),
			to_date: Type.Optional(
				Type.String({
					description: 'End date for search range (ISO 8601, e.g. "2025-12-31")',
				}),
			),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider("xai-oauth");
			if (!apiKey) {
				return {
					content: [{ type: "text", text: "Error: no xAI credentials. Run /login to authenticate." }],
					isError: true,
				};
			}

			// Resolve base URL — prefer the provider's configured URL.
			const allModels = ctx.modelRegistry.getAll();
			const xaiModel = allModels.find((m) => m.provider === "xai-oauth");
			const baseUrl = (xaiModel?.baseUrl ?? "https://api.x.ai/v1").replace(/\/+$/, "");

			const result = await callXSearch(
				apiKey,
				baseUrl,
				params.query,
				{
					allowedXHandles: params.allowed_x_handles,
					excludedXHandles: params.excluded_x_handles,
					fromDate: params.from_date,
					toDate: params.to_date,
				},
				signal,
			);

			let text = result.answer;
			if (result.citations?.length) {
				text += "\n\nSources:\n";
				for (const c of result.citations) {
					text += `- ${c.title ? c.title + " " : ""}${c.url}\n`;
				}
			}

			return {
				content: [{ type: "text", text }],
			};
		},
	});
}

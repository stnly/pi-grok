/**
 * x_search tool: proxy xAI's built-in X Search via a separate API call.
 *
 * When the model calls this tool, we make an independent request to xAI's
 * Responses API with the server-side x_search tool. This means:
 *
 *   - Any model can search X
 *   - The search call uses a dedicated model with full x_search support
 *   - Results come back as structured tool output visible in pi's UI
 *   - Per-query parameters (handles, date ranges) are supported
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CLI_PROXY_BASE_URL, buildProxyHeaders } from "./models.js";
import { readBoundedJson, readBoundedText, safeFetch } from "./safe-fetch.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const SEARCH_MODEL = process.env.PI_XAI_X_SEARCH_MODEL ?? "grok-4.5";
/** Reject any x_search response body larger than this before parsing. */
const SEARCH_MAX_RESPONSE_BYTES = 256 * 1024;

// ─── Types ───────────────────────────────────────────────────────────────────

interface XSearchResult {
	answer: string;
	citations?: Array<{ url: string; title?: string }>;
}

/** Map a thrown x_search error to the user-facing text and status shown in
 * the tool result. 401 gets a re-login hint; anything else surfaces the
 * message. Extracted so the mapping is testable without a tool ctx. */
export function formatXSearchError(err: unknown): { text: string; status?: number } {
	if (err instanceof XSearchHttpError) {
		if (err.status === 401) {
			return { text: "xAI authentication failed. Run /login to re-authenticate.", status: 401 };
		}
		return { text: `x_search failed: ${err.message}`, status: err.status };
	}
	return { text: `x_search failed: ${err instanceof Error ? err.message : String(err)}` };
}

/** HTTP failure from the x_search Responses call, carrying the status so the
 * tool handler can map 401 to a re-login message. */
export class XSearchHttpError extends Error {
	constructor(public readonly status: number, body: string) {
		super(`x_search HTTP ${status}: ${body.slice(0, 500)}`);
		this.name = "XSearchHttpError";
	}
}

// ─── API call ────────────────────────────────────────────────────────────────

export async function callXSearch(
	apiKey: string,
	baseUrl: string,
	query: string,
	options?: {
		allowedXHandles?: string[];
		excludedXHandles?: string[];
		fromDate?: string;
		toDate?: string;
	},
	signal?: AbortSignal,
): Promise<XSearchResult> {
	const xSearchTool: Record<string, unknown> = { type: "x_search" };
	if (options?.allowedXHandles?.length) xSearchTool.allowed_x_handles = options.allowedXHandles;
	if (options?.excludedXHandles?.length) xSearchTool.excluded_x_handles = options.excludedXHandles;
	if (options?.fromDate) xSearchTool.from_date = options.fromDate;
	if (options?.toDate) xSearchTool.to_date = options.toDate;

	const payload = {
		model: SEARCH_MODEL,
		input: [{ role: "user", content: query }],
		tools: [xSearchTool],
		store: false,
	};

	const response = await safeFetch(`${baseUrl}/responses`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			...buildProxyHeaders(SEARCH_MODEL),
		},
		body: JSON.stringify(payload),
		// Bound the call so a stalled proxy never wedges the tool. Combine the
		// caller's cancel signal with a 30s deadline so either one fires.
		signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
	});

	if (!response.ok) {
		const body = await readBoundedText(response, SEARCH_MAX_RESPONSE_BYTES).catch(() => "");
		throw new XSearchHttpError(response.status, body);
	}

	const data = (await readBoundedJson(response, SEARCH_MAX_RESPONSE_BYTES)) as {
		output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
		citations?: Array<{ url: string; title?: string }>;
	};

	// Extract text from the Responses API output
	const textParts: string[] = [];
	for (const item of data.output ?? []) {
		if (item.type === "message" && Array.isArray(item.content)) {
			for (const part of item.content) {
				if (part.type === "output_text" && part.text) {
					textParts.push(part.text);
				}
			}
		}
	}

	const citations: XSearchResult["citations"] = [];
	for (const c of data.citations ?? []) {
		if (c.url) citations.push({ url: c.url, title: c.title });
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
				description: "Search query: keywords, hashtags, or natural language description of what to find",
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
					details: {},
				};
			}

			// X search rides the cli-chat-proxy so the call uses the same
			// subscription path as inference.
			const baseUrl = CLI_PROXY_BASE_URL;

			let result: XSearchResult;
			try {
				result = await callXSearch(
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
			} catch (err) {
				const mapped = formatXSearchError(err);
				return {
					content: [{ type: "text", text: mapped.text }],
					isError: true,
					details: mapped.status !== undefined ? { status: mapped.status } : {},
				};
			}

			let text = result.answer;
			if (result.citations?.length) {
				text += "\n\nSources:\n";
				for (const c of result.citations) {
					text += `- ${c.title ? c.title + " " : ""}${c.url}\n`;
				}
			}

			return {
				content: [{ type: "text", text }],
				details: {},
			};
		},
	});
}

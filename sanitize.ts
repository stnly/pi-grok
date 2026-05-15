/**
 * Payload sanitization for xAI's Responses API.
 *
 * xAI's endpoint has quirks compared to stock OpenAI:
 *   - Replayed `reasoning` items in input cause 400 errors.
 *   - `input_image` / `image_url` content types cause 422 deserialization errors.
 *   - `reasoning.effort` is only supported on a subset of models.
 *   - Empty-string content items cause validation failures.
 *
 * This module strips / transforms those before the request is sent.
 * It's intended to be called from a `before_provider_request` event handler,
 * keeping sanitization decoupled from the streaming implementation.
 */

import { supportsReasoningEffort } from "./models.js";

/**
 * Sanitize a provider request payload for xAI's Responses API.
 *
 * Returns the modified payload.  Mutates the input in place for efficiency.
 */
export function sanitizePayload(params: Record<string, unknown>, modelId: string): Record<string, unknown> {
	const next = params;

	let strippedImages = false;

	// ── Sanitize input array ──────────────────────────────────────────────
	if (Array.isArray(next.input)) {
		next.input = next.input
			.map((item: unknown) => {
				if (!item || typeof item !== "object") return item;
				const obj = item as Record<string, unknown>;

				// Strip replayed reasoning items
				if (obj.type === "reasoning") return null;

				// Handle messages with content arrays
				if (Array.isArray(obj.content)) {
					const sanitized = (obj.content as unknown[])
						.map((part: unknown) => {
							if (!part || typeof part !== "object") return part;
							const p = part as Record<string, unknown>;
							// xAI Responses API rejects input_image / image_url
							if (p.type === "input_image" || p.type === "image_url") {
								strippedImages = true;
								return {
									type: "input_text",
									text: "[Image omitted — xAI Responses API does not support image uploads]",
								};
							}
							return p;
						})
						.filter(Boolean);

					if (sanitized.length === 0) return null;
					return { ...obj, content: sanitized };
				}

				// Drop empty string content
				if (typeof obj.content === "string" && obj.content.length === 0) return null;

				return obj;
			})
			.filter(Boolean);
	}

	if (strippedImages) {
		console.warn("[pi-grok] Images stripped from request — xAI Responses API does not support them.");
	}

	// ── Reasoning effort ──────────────────────────────────────────────────
	if (supportsReasoningEffort(modelId)) {
		// This model supports the effort dial — just remap 'minimal' → 'low'
		// (xAI doesn't have a 'minimal' level).
		const reasoning = next.reasoning as Record<string, unknown> | undefined;
		if (reasoning && reasoning.effort === "minimal") {
			next.reasoning = { ...reasoning, effort: "low" };
		}
		// Strip `summary` — xAI doesn't support it.
		if (reasoning && reasoning.summary !== undefined) {
			next.reasoning = { effort: reasoning.effort };
		}
	} else {
		// Model doesn't support reasoning.effort at all — remove it.
		delete next.reasoning;
	}

	// ── Strip unsupported fields ──────────────────────────────────────────
	delete next.include;

	return next;
}

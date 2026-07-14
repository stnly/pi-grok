/**
 * Payload sanitization for xAI's Responses API.
 *
 * xAI's endpoint has quirks compared to stock OpenAI:
 *   - Replayed `reasoning` items in input cause 400 errors.
 *   - `reasoning.effort` is only supported on a subset of models.
 *   - Empty-string content items cause validation failures.
 *   - `function_call_output.output` cannot contain image arrays.
 *   - `image_url` parts must be normalized to `input_image` with data URIs.
 *   - Local image paths must be resolved to base64 data URIs.
 *   - xAI rejects `role: "developer"` and `role: "system"` in the input
 *     array; these must be moved to top-level `instructions`.
 *   - xAI uses `text.format` instead of OpenAI's `response_format`.
 *   - xAI uses `prompt_cache_key` for conversation caching.
 *   - xAI doesn't support `prompt_cache_retention`.
 *
 * This module normalizes images and rewrites unsupported fields before the
 * request is sent.  It's intended to be called from a
 * `before_provider_request` event handler, keeping sanitization decoupled
 * from the streaming implementation.
 */

import { existsSync, readFileSync } from "fs";
import { extname, isAbsolute, resolve } from "path";
import { fileURLToPath } from "url";
import { supportsReasoningEffort } from "./models.js";

// ─── Content text extraction ─────────────────────────────────────────────────

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (!part || typeof part !== "object") return "";
			const item = part as Record<string, unknown>;
			const type = typeof item.type === "string" ? item.type : "";
			return ["text", "input_text", "output_text"].includes(type) && typeof item.text === "string" ? item.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

// ─── Image helpers ────────────────────────────────────────────────────────────

function stripShellQuotes(value: string): string {
	const trimmed = value.trim();
	if (
		trimmed.length >= 2 &&
		((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
			(trimmed.startsWith("'") && trimmed.endsWith("'")))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function unescapeShellPath(value: string): string {
	return stripShellQuotes(value).replace(/\\([\\\s'"()&;@])/g, "$1");
}

function imageMimeTypeForPath(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		default:
			throw new Error(
				"xAI image understanding supports local .jpg, .jpeg, and .png files only",
			);
	}
}

function resolveLocalImagePath(value: string): string | undefined {
	const cleaned = unescapeShellPath(value);
	if (!cleaned) return undefined;

	if (cleaned.startsWith("file://")) {
		try {
			return fileURLToPath(cleaned);
		} catch {
			return undefined;
		}
	}

	const candidates = [cleaned];
	if (!isAbsolute(cleaned)) candidates.push(resolve(process.cwd(), cleaned));

	return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Normalize an image input value to a URL or data URI string.
 *
 * Accepts:
 *   - http(s) URLs
 *   - data:image/... base64 URIs
 *   - Local file paths (resolved to data URIs)
 *   - file:// URLs (resolved to data URIs)
 */
function normalizeImageInput(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const cleaned = stripShellQuotes(value);

	if (/^https?:\/\//i.test(cleaned) || /^data:image\//i.test(cleaned)) {
		return cleaned;
	}

	const localPath = resolveLocalImagePath(cleaned);
	if (!localPath) {
		throw new Error(`Image file does not exist or is not a valid URL: ${cleaned}`);
	}

	const mimeType = imageMimeTypeForPath(localPath);
	const data = readFileSync(localPath).toString("base64");
	return `data:${mimeType};base64,${data}`;
}

// ─── Content part normalization ───────────────────────────────────────────────

function isInputImagePart(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && (value as Record<string, unknown>).type === "input_image";
}

function normalizeImageParts(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeImageParts);
	if (!value || typeof value !== "object") return value;

	const obj = { ...(value as Record<string, unknown>) };

	// Normalize { type: "image", data, mimeType } → input_image with data URI
	if (obj.type === "image" && typeof obj.data === "string" && typeof obj.mimeType === "string") {
		return {
			type: "input_image",
			image_url: `data:${obj.mimeType};base64,${obj.data}`,
			detail: typeof obj.detail === "string" && obj.detail ? obj.detail : "auto",
		};
	}

	// Normalize { type: "image_url", image_url: { url, detail } } → input_image
	if (obj.type === "image_url") {
		const imageUrl =
			typeof obj.image_url === "object" && obj.image_url
				? (obj.image_url as Record<string, unknown>).url
				: obj.image_url;
		const detail =
			typeof obj.image_url === "object" && obj.image_url
				? (obj.image_url as Record<string, unknown>).detail
				: obj.detail;
		obj.type = "input_image";
		obj.image_url = imageUrl;
		if (typeof detail === "string" && detail) obj.detail = detail;
	}

	// Normalize input_image: resolve local paths to data URIs
	if (obj.type === "input_image") {
		const imageUrl =
			typeof obj.image_url === "object" && obj.image_url
				? (obj.image_url as Record<string, unknown>).url
				: obj.image_url;
		const detail =
			typeof obj.image_url === "object" && obj.image_url
				? (obj.image_url as Record<string, unknown>).detail
				: obj.detail;
		const normalized = normalizeImageInput(imageUrl);
		if (normalized) obj.image_url = normalized;
		if (typeof detail === "string" && detail) obj.detail = detail;
		if (typeof obj.detail !== "string" || !obj.detail) obj.detail = "auto";
	}

	if (Array.isArray(obj.content)) obj.content = normalizeImageParts(obj.content);
	if (Array.isArray(obj.output)) obj.output = normalizeImageParts(obj.output);
	return obj;
}

// ─── function_call_output rewrite ─────────────────────────────────────────────

/**
 * xAI rejects image arrays inside `function_call_output.output`.  Extract
 * images into a separate user message so they're delivered as normal input.
 */
function rewriteFunctionCallOutput(
	input: Record<string, unknown>[],
): Record<string, unknown>[] {
	const rewritten: Record<string, unknown>[] = [];

	for (const item of input) {
		if (
			!item ||
			typeof item !== "object" ||
			item.type !== "function_call_output" ||
			!Array.isArray(item.output)
		) {
			rewritten.push(item);
			continue;
		}

		const outputParts = item.output as unknown[];
		const imageParts = outputParts.filter(isInputImagePart);
		const textParts = outputParts.filter((p) => !isInputImagePart(p));

		// Build text-only output
		const textChunks: string[] = [];
		for (const part of textParts) {
			if (typeof part === "string") {
				textChunks.push(part);
			} else if (part && typeof part === "object") {
				const p = part as Record<string, unknown>;
				if (typeof p.text === "string") textChunks.push(p.text);
			}
		}
		let imageCount = 0;
		for (const _ of imageParts) imageCount++;

		const outputText = textChunks.join("\n") || "(tool returned no text output)";
		rewritten.push({ ...item, output: outputText });

		if (imageCount > 0) {
			const callId = item.call_id ? ` (${String(item.call_id)})` : "";
			const label = `The previous tool result${callId} included ${imageCount} image${imageCount === 1 ? "" : "s"}. Use the attached image${imageCount === 1 ? "" : "s"} as the visual output from that tool.`;
			rewritten.push({
				role: "user",
				content: [{ type: "input_text", text: label }, ...imageParts],
			});
		}
	}

	return rewritten;
}

// ─── Main sanitization ────────────────────────────────────────────────────────

/**
 * Sanitize a provider request payload for xAI's Responses API.
 *
 * Returns the modified payload.  Mutates the input in place for efficiency.
 */
export function sanitizePayload(
	params: Record<string, unknown>,
	modelId: string,
	sessionId?: string,
): Record<string, unknown> {
	const next = params;

	// ── Sanitize input array ──────────────────────────────────────────────
	if (Array.isArray(next.input)) {
		let input = (next.input as unknown[])
			.map((item: unknown) => {
				if (!item || typeof item !== "object") return item;
				const obj = item as Record<string, unknown>;

				// Strip replayed reasoning items
				if (obj.type === "reasoning") return null;

				// Drop empty string content
				if (typeof obj.content === "string" && obj.content.length === 0)
					return null;

				return obj;
			})
			.filter(Boolean) as Record<string, unknown>[];

		// Move system/developer messages to top-level instructions.
		// xAI rejects role: "developer" and role: "system" in the input array.
		const instructionParts: string[] = [];
		while (input.length > 0) {
			const first = input[0];
			if (!first || typeof first !== "object") break;
			const role = (first as Record<string, unknown>).role;
			if (role !== "developer" && role !== "system") break;
			const text = textFromContent((first as Record<string, unknown>).content).trim();
			if (text) instructionParts.push(text);
			input.shift();
		}
		if (instructionParts.length > 0) {
			const existing = typeof next.instructions === "string" && next.instructions ? next.instructions : "";
			const merged = [existing, ...instructionParts].filter((part) => part.length > 0).join("\n\n");
			next.instructions = merged;
		}

		// Normalize image parts (resolve local paths, fix types)
		input = normalizeImageParts(input) as Record<string, unknown>[];

		// Rewrite function_call_output with images
		input = rewriteFunctionCallOutput(input);

		next.input = input;
	} else if (typeof next.input === "string") {
		// String input is valid and should stay string-shaped.
	}

	// ── response_format → text.format ────────────────────────────────────
	// xAI uses { text: { format: ... } } instead of { response_format: ... }.
	if (next.response_format && !next.text) {
		next.text = { format: next.response_format };
		delete next.response_format;
	}

	// ── Reasoning effort ──────────────────────────────────────────────────
	if (supportsReasoningEffort(modelId)) {
		// This model supports the effort dial; remap 'minimal' to 'low'
		// (xAI doesn't have a 'minimal' level).
		const reasoning = next.reasoning as Record<string, unknown> | undefined;
		if (reasoning && reasoning.effort === "minimal") {
			next.reasoning = { ...reasoning, effort: "low" };
		}
		// Strip `summary`; xAI doesn't support it.
		if (reasoning && reasoning.summary !== undefined) {
			next.reasoning = { effort: reasoning.effort };
		}
	} else {
		// Model doesn't support reasoning.effort at all; remove it.
		delete next.reasoning;
	}

	// ── Strip/filter unsupported fields ──────────────────────────────────
	// xAI doesn't support reasoning.encrypted_content in include.
	if (Array.isArray(next.include)) {
		next.include = (next.include as unknown[]).filter(
			(item) => item !== "reasoning.encrypted_content",
		);
		if ((next.include as unknown[]).length === 0) delete next.include;
	}

	// xAI doesn't support prompt_cache_retention.
	delete next.prompt_cache_retention;

	// Add prompt_cache_key for conversation caching (routes to same server).
	if (sessionId && !next.prompt_cache_key) {
		next.prompt_cache_key = sessionId;
	}

	return next;
}

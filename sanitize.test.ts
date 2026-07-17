import { describe, expect, it } from "vitest";
import { sanitizePayload } from "./sanitize.js";

function basePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
	return { model: "grok-4.5", input: [{ role: "user", content: "hi" }], ...over };
}

// ─── Reasoning effort ────────────────────────────────────────────────────────

describe("sanitizePayload reasoning effort", () => {
	describe("effort-capable model (grok-4.5)", () => {
		it("preserves minimal and strips summary", () => {
			const p = sanitizePayload(
				{ ...basePayload(), reasoning: { effort: "minimal", summary: "auto" } },
				"grok-4.5",
			);
			expect(p.reasoning).toEqual({ effort: "minimal" });
		});

		it("keeps low and strips summary", () => {
			const p = sanitizePayload(
				{ ...basePayload(), reasoning: { effort: "low", summary: "auto" } },
				"grok-4.5",
			);
			expect(p.reasoning).toEqual({ effort: "low" });
		});

		it("keeps medium and strips summary", () => {
			const p = sanitizePayload(
				{ ...basePayload(), reasoning: { effort: "medium", summary: "auto" } },
				"grok-4.5",
			);
			expect(p.reasoning).toEqual({ effort: "medium" });
		});

		it("keeps high", () => {
			const p = sanitizePayload(
				{ ...basePayload(), reasoning: { effort: "high", summary: "auto" } },
				"grok-4.5",
			);
			expect(p.reasoning).toEqual({ effort: "high" });
		});

		it("keeps xhigh", () => {
			const p = sanitizePayload(
				{ ...basePayload(), reasoning: { effort: "xhigh", summary: "auto" } },
				"grok-4.5",
			);
			expect(p.reasoning).toEqual({ effort: "xhigh" });
		});

		it("leaves effort unchanged when summary is already absent", () => {
			const p = sanitizePayload(
				{ ...basePayload(), reasoning: { effort: "low" } },
				"grok-4.5",
			);
			expect(p.reasoning).toEqual({ effort: "low" });
		});

		it("honors a provider-qualified model id", () => {
			const p = sanitizePayload(
				{ ...basePayload(), reasoning: { effort: "low", summary: "auto" } },
				"xai-oauth/grok-4.5",
			);
			expect(p.reasoning).toEqual({ effort: "low" });
		});

		// Agreement contract: the host's thinkingLevelMapFor hides "off" for
		// effort-capable models, so "none" never reaches the wire. The
		// sanitizer does NOT strip "none" itself; the map is the sole gate.
		// This pins that contract: if "none" ever appears here, it is a
		// caller bug, not something the sanitizer silently fixes.
		it("passes effort 'none' through unchanged (the map hides off, not the sanitizer)", () => {
			const p = sanitizePayload(
				{ ...basePayload(), reasoning: { effort: "none" } },
				"grok-4.5",
			);
			expect(p.reasoning).toEqual({ effort: "none" });
		});
	});

	describe("non-effort model", () => {
		it("drops reasoning entirely regardless of effort", () => {
			const p = sanitizePayload(
				{ ...basePayload(), reasoning: { effort: "low", summary: "auto" } },
				"grok-4.20-0309-non-reasoning",
			);
			expect(p.reasoning).toBeUndefined();
		});
	});

	it("leaves the payload untouched when reasoning is absent", () => {
		const p = sanitizePayload(basePayload(), "grok-4.5");
		expect(p.reasoning).toBeUndefined();
		expect(p.input).toBeDefined();
	});
});

// ─── Input array quirks ──────────────────────────────────────────────────────

describe("sanitizePayload input array", () => {
	it("strips replayed reasoning items", () => {
		const p = sanitizePayload(
			{
				model: "grok-4.5",
				input: [
					{ type: "reasoning", content: "should be dropped" },
					{ role: "user", content: "keep" },
				],
			},
			"grok-4.5",
		);
		const input = p.input as Array<Record<string, unknown>>;
		expect(input).toHaveLength(1);
		expect(input[0]).toMatchObject({ role: "user" });
	});

	it("drops items with empty-string content", () => {
		const p = sanitizePayload(
			{
				model: "grok-4.5",
				input: [
					{ role: "user", content: "" },
					{ role: "user", content: "keep" },
				],
			},
			"grok-4.5",
		);
		const input = p.input as Array<Record<string, unknown>>;
		expect(input).toHaveLength(1);
		expect((input[0] as any).content).toBe("keep");
	});

	it("moves leading system messages into top-level instructions", () => {
		const p = sanitizePayload(
			{
				model: "grok-4.5",
				input: [
					{ role: "system", content: "be brief" },
					{ role: "developer", content: "use tabs" },
					{ role: "user", content: "hi" },
				],
			},
			"grok-4.5",
		);
		const input = p.input as Array<Record<string, unknown>>;
		expect(input.every((m) => (m as any).role === "user")).toBe(true);
		expect(p.instructions).toBe("be brief\n\nuse tabs");
	});

	it("stops migrating at the first non-system message", () => {
		const p = sanitizePayload(
			{
				model: "grok-4.5",
				input: [
					{ role: "system", content: "top" },
					{ role: "user", content: "mid" },
					{ role: "system", content: "not moved" },
				],
			},
			"grok-4.5",
		);
		const input = p.input as Array<Record<string, unknown>>;
		expect(input.map((m) => (m as any).role)).toEqual(["user", "system"]);
		expect(p.instructions).toBe("top");
	});

	it("merges migrated system text onto an existing instructions field", () => {
		const p = sanitizePayload(
			{
				model: "grok-4.5",
				instructions: "base",
				input: [{ role: "system", content: "added" }],
			},
			"grok-4.5",
		);
		expect(p.instructions).toBe("base\n\nadded");
	});

	it("leaves string input untouched", () => {
		const p = sanitizePayload({ model: "grok-4.5", input: "plain string" }, "grok-4.5");
		expect(p.input).toBe("plain string");
	});
});

// ─── Field rewrites ──────────────────────────────────────────────────────────

describe("sanitizePayload field rewrites", () => {
	it("rewrites response_format to text.format", () => {
		const p = sanitizePayload(
			{ ...basePayload(), response_format: { type: "json_object" } },
			"grok-4.5",
		);
		expect(p.text).toEqual({ format: { type: "json_object" } });
		expect(p.response_format).toBeUndefined();
	});

	it("does not overwrite an existing text field", () => {
		const p = sanitizePayload(
			{ ...basePayload(), response_format: { type: "json" }, text: { format: "keep" } },
			"grok-4.5",
		);
		expect(p.text).toEqual({ format: "keep" });
		expect(p.response_format).toBeDefined();
	});

	it("strips reasoning.encrypted_content from include", () => {
		const p = sanitizePayload(
			{ ...basePayload(), include: ["reasoning.encrypted_content", "other"] },
			"grok-4.5",
		);
		expect(p.include).toEqual(["other"]);
	});

	it("drops include when it would be empty", () => {
		const p = sanitizePayload(
			{ ...basePayload(), include: ["reasoning.encrypted_content"] },
			"grok-4.5",
		);
		expect(p.include).toBeUndefined();
	});

	it("deletes prompt_cache_retention", () => {
		const p = sanitizePayload(
			{ ...basePayload(), prompt_cache_retention: { key: "x" } },
			"grok-4.5",
		);
		expect(p.prompt_cache_retention).toBeUndefined();
	});

	it("injects prompt_cache_key from the session id when absent", () => {
		const p = sanitizePayload(basePayload(), "grok-4.5", "sess-123");
		expect(p.prompt_cache_key).toBe("sess-123");
	});

	it("does not overwrite an existing prompt_cache_key", () => {
		const p = sanitizePayload(
			{ ...basePayload(), prompt_cache_key: "existing" },
			"grok-4.5",
			"sess-123",
		);
		expect(p.prompt_cache_key).toBe("existing");
	});

	it("omits prompt_cache_key when no session id is given", () => {
		const p = sanitizePayload(basePayload(), "grok-4.5");
		expect(p.prompt_cache_key).toBeUndefined();
	});
});

// ─── Image normalization ─────────────────────────────────────────────────────

describe("sanitizePayload image normalization", () => {
	it("normalizes an https image_url part to input_image", () => {
		const p = sanitizePayload(
			{
				model: "grok-4.5",
				input: [
					{
						role: "user",
						content: [{ type: "image_url", image_url: { url: "https://x.ai/a.png" } }],
					},
				],
			},
			"grok-4.5",
		);
		const content = (p.input as any[])[0].content as any[];
		expect(content[0].type).toBe("input_image");
		expect(content[0].image_url).toBe("https://x.ai/a.png");
	});

	it("passes http(s) and data URIs through resolved", () => {
		const p = sanitizePayload(
			{
				model: "grok-4.5",
				input: [
					{
						role: "user",
						content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
					},
				],
			},
			"grok-4.5",
		);
		const content = (p.input as any[])[0].content as any[];
		expect(content[0].image_url).toBe("data:image/png;base64,AAAA");
		expect(content[0].detail).toBe("auto");
	});
});

// ─── function_call_output rewrite ────────────────────────────────────────────

describe("sanitizePayload function_call_output", () => {
	it("flattens a text-only output array to a string", () => {
		const p = sanitizePayload(
			{
				model: "grok-4.5",
				input: [
					{
						type: "function_call_output",
						call_id: "c1",
						output: [{ type: "output_text", text: "line1" }, { type: "output_text", text: "line2" }],
					},
				],
			},
			"grok-4.5",
		);
		const item = (p.input as any[])[0];
		expect(item.output).toBe("line1\nline2");
	});

	it("extracts image parts into a follow-up user message", () => {
		const p = sanitizePayload(
			{
				model: "grok-4.5",
				input: [
					{
						type: "function_call_output",
						call_id: "c1",
						output: [
							{ type: "output_text", text: "done" },
							{ type: "input_image", image_url: "https://x.ai/a.png" },
						],
					},
				],
			},
			"grok-4.5",
		);
		const input = p.input as any[];
		// Original output is text-only now.
		expect(input[0].output).toBe("done");
		// A user message carrying the image was appended.
		const appended = input[input.length - 1];
		expect(appended.role).toBe("user");
		expect(appended.content.some((c: any) => c.type === "input_image")).toBe(true);
	});

	it("uses a placeholder when the output array has no text", () => {
		const p = sanitizePayload(
			{
				model: "grok-4.5",
				input: [{ type: "function_call_output", call_id: "c1", output: [] }],
			},
			"grok-4.5",
		);
		expect((p.input as any[])[0].output).toMatch(/no text output/);
	});
});

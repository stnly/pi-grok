import { describe, expect, it } from "vitest";
import { sanitizePayload } from "./sanitize.js";

// Minimal payload shape: xAI Responses API accepts `input` and `model`.
function basePayload(): Record<string, unknown> {
	return {
		model: "grok-4.5",
		input: [{ role: "user", content: "hi" }],
	};
}

describe("sanitizePayload reasoning effort", () => {
	describe("effort-capable model (grok-4.5)", () => {
		it("preserves minimal and strips summary", () => {
			const payload = sanitizePayload(
				{ ...basePayload(), reasoning: { effort: "minimal", summary: "auto" } },
				"grok-4.5",
			);
			expect(payload.reasoning).toEqual({ effort: "minimal" });
		});

		it("keeps low and strips summary", () => {
			const payload = sanitizePayload(
				{ ...basePayload(), reasoning: { effort: "low", summary: "auto" } },
				"grok-4.5",
			);
			expect(payload.reasoning).toEqual({ effort: "low" });
		});

		it("keeps medium and strips summary", () => {
			const payload = sanitizePayload(
				{ ...basePayload(), reasoning: { effort: "medium", summary: "auto" } },
				"grok-4.5",
			);
			expect(payload.reasoning).toEqual({ effort: "medium" });
		});

		it("keeps high", () => {
			const payload = sanitizePayload(
				{ ...basePayload(), reasoning: { effort: "high", summary: "auto" } },
				"grok-4.5",
			);
			expect(payload.reasoning).toEqual({ effort: "high" });
		});

		it("honors a provider-qualified model id", () => {
			const payload = sanitizePayload(
				{ ...basePayload(), reasoning: { effort: "low", summary: "auto" } },
				"xai-oauth/grok-4.5",
			);
			expect(payload.reasoning).toEqual({ effort: "low" });
		});
	});

	describe("non-effort model", () => {
		it("drops reasoning entirely regardless of effort", () => {
			const payload = sanitizePayload(
				{ ...basePayload(), reasoning: { effort: "low", summary: "auto" } },
				"grok-4.20-0309-non-reasoning",
			);
			expect(payload.reasoning).toBeUndefined();
		});
	});

	describe("no reasoning field", () => {
		it("leaves the payload untouched when reasoning is absent", () => {
			const payload = sanitizePayload(basePayload(), "grok-4.5");
			expect(payload.reasoning).toBeUndefined();
			expect(payload.input).toBeDefined();
		});
	});
});

import { describe, expect, it } from "vitest";
import {
	BoundedJsonError,
	assertBoundedJson,
	parseBoundedJson,
	type BoundedJsonOptions,
} from "./bounded-json.js";

// Default bounds used by the module. Tests assert against these values so a
// drift in the defaults is caught here rather than downstream.
const DEFAULTS: Required<BoundedJsonOptions> = {
	maxDepth: 12,
	maxNodes: 2048,
	maxArrayItems: 64,
	maxObjectKeys: 64,
};

describe("parseBoundedJson", () => {
	it("parses a small well-formed JSON value", () => {
		expect(parseBoundedJson('{"a":1,"b":[1,2,3]}')).toEqual({ a: 1, b: [1, 2, 3] });
	});

	it("parses primitives, not just objects", () => {
		expect(parseBoundedJson("42")).toBe(42);
		expect(parseBoundedJson('"hi"')).toBe("hi");
		expect(parseBoundedJson("null")).toBeNull();
	});

	it("throws BoundedJsonError on invalid JSON", () => {
		expect(() => parseBoundedJson("{not json")).toThrow(BoundedJsonError);
		expect(() => parseBoundedJson("")).toThrow(BoundedJsonError);
	});

	it("throws BoundedJsonError on a depth overflow", () => {
		// Nested 13 deep under default maxDepth=12.
		let json = "1";
		for (let i = 0; i < 13; i++) json = `[${json}]`;
		expect(() => parseBoundedJson(json)).toThrow(BoundedJsonError);
	});

	it("accepts a structure exactly at maxDepth", () => {
		// 12 nested arrays under default maxDepth=12 (root is depth 0).
		let json = "1";
		for (let i = 0; i < 12; i++) json = `[${json}]`;
		expect(() => parseBoundedJson(json)).not.toThrow();
	});

	it("throws BoundedJsonError on an array-items overflow", () => {
		const arr = Array.from({ length: DEFAULTS.maxArrayItems + 1 }, (_, i) => i);
		expect(() => parseBoundedJson(JSON.stringify(arr))).toThrow(BoundedJsonError);
	});

	it("accepts an array at exactly maxArrayItems", () => {
		const arr = Array.from({ length: DEFAULTS.maxArrayItems }, (_, i) => i);
		expect(() => parseBoundedJson(JSON.stringify(arr))).not.toThrow();
	});

	it("throws BoundedJsonError on an object-keys overflow", () => {
		const obj: Record<string, number> = {};
		for (let i = 0; i < DEFAULTS.maxObjectKeys + 1; i++) obj[`k${i}`] = i;
		expect(() => parseBoundedJson(JSON.stringify(obj))).toThrow(BoundedJsonError);
	});

	it("accepts an object at exactly maxObjectKeys", () => {
		const obj: Record<string, number> = {};
		for (let i = 0; i < DEFAULTS.maxObjectKeys; i++) obj[`k${i}`] = i;
		expect(() => parseBoundedJson(JSON.stringify(obj))).not.toThrow();
	});

	it("throws BoundedJsonError on a total-node overflow", () => {
		// Raise the array/key caps so maxNodes is what trips, not maxArrayItems.
		const opts = { maxArrayItems: 10_000, maxObjectKeys: 10_000, maxNodes: 50 };
		const arr = Array.from({ length: 51 }, (_, i) => i);
		expect(() => parseBoundedJson(JSON.stringify(arr), opts)).toThrow(BoundedJsonError);
	});

	it("respects caller-supplied options", () => {
		// Tighter bounds than defaults.
		expect(() => parseBoundedJson("[1,2,3]", { maxArrayItems: 2 })).toThrow(BoundedJsonError);
		expect(() => parseBoundedJson('{"a":1,"b":2,"c":3}', { maxObjectKeys: 2 })).toThrow(BoundedJsonError);
	});

	it("does not mutate the caller's options object", () => {
		const opts: BoundedJsonOptions = { maxArrayItems: 5 };
		parseBoundedJson("[1,2]", opts);
		expect(opts).toEqual({ maxArrayItems: 5 });
	});
});

describe("assertBoundedJson", () => {
	it("passes silently for a value within bounds", () => {
		expect(() => assertBoundedJson({ a: [1, 2, 3] })).not.toThrow();
	});

	it("throws BoundedJsonError on a depth overflow", () => {
		// Build a deeply nested object programmatically.
		let v: unknown = 1;
		for (let i = 0; i < DEFAULTS.maxDepth + 1; i++) v = { x: v };
		expect(() => assertBoundedJson(v)).toThrow(BoundedJsonError);
	});

	it("throws BoundedJsonError on a node-count overflow", () => {
		// Raise the array/key caps so maxNodes is what trips, not maxArrayItems.
		// Without this, a 2049-item flat array hits the default maxArrayItems=64
		// first and the test passes for the wrong reason.
		const opts = { maxArrayItems: 10_000, maxObjectKeys: 10_000 };
		const arr = Array.from({ length: DEFAULTS.maxNodes + 1 }, (_, i) => i);
		expect(() => assertBoundedJson(arr, opts)).toThrow(BoundedJsonError);
	});

	it("treats a primitive as in-bounds", () => {
		expect(() => assertBoundedJson("just a string")).not.toThrow();
		expect(() => assertBoundedJson(123)).not.toThrow();
		expect(() => assertBoundedJson(null)).not.toThrow();
	});

	it("rejects cycles by throwing (JSON.stringify-style)", () => {
		const cyclic: unknown[] = [];
		cyclic.push(cyclic);
		// The walker treats arrays and plain objects; a self-referential array
		// recurses without termination, so a node-count overflow trips first.
		expect(() => assertBoundedJson(cyclic)).toThrow(BoundedJsonError);
	});
});

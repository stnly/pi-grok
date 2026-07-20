/**
 * Bounded JSON parsing for untrusted responses.
 *
 * `JSON.parse` on an attacker-controlled body has no depth, node, or width
 * limit, so a pathological response can exhaust memory or stack. Any xAI
 * response that comes from an unofficial or loosely-specified endpoint goes
 * through here first: the body must parse as JSON, then the resulting value
 * must fit within documented depth, breadth, and total-node ceilings.
 *
 * The ceilings are conservative defaults tuned for the responses we actually
 * see from cli-chat-proxy endpoints (catalog, billing, usage). Callers can
 * tighten them further for narrower surfaces.
 */

/** Tunable limits for a bounded parse. All optional; defaults apply when unset. */
export interface BoundedJsonOptions {
	/** Maximum nesting depth. Root is depth 0; each nested array or object adds 1. */
	maxDepth?: number;
	/** Maximum total nodes walked (objects, arrays, and primitives each count as one). */
	maxNodes?: number;
	/** Maximum items in any single array. */
	maxArrayItems?: number;
	/** Maximum keys in any single object. */
	maxObjectKeys?: number;
}

const DEFAULT_BOUNDED_JSON_OPTIONS: Required<BoundedJsonOptions> = {
	maxDepth: 12,
	maxNodes: 2048,
	maxArrayItems: 64,
	maxObjectKeys: 64,
};

/** Error thrown when a value exceeds the requested bounds, or when the input is not valid JSON. */
export class BoundedJsonError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BoundedJsonError";
	}
}

interface WalkState {
	depth: number;
	nodes: number;
}

/**
 * Walk a parsed value and throw BoundedJsonError if any limit is exceeded.
 *
 * The walker treats only `object` (non-null) and `Array` as containers; it
 * counts every value (containers and primitives) as one node. A cycle in the
 * input eventually trips the node-count ceiling, which is the only defense
 * `JSON.parse` itself does not provide.
 */
export function assertBoundedJson(
	value: unknown,
	options: BoundedJsonOptions = {},
	state: WalkState = { depth: 0, nodes: 0 },
): void {
	const opts = { ...DEFAULT_BOUNDED_JSON_OPTIONS, ...options };
	state.nodes += 1;
	if (state.nodes > opts.maxNodes) {
		throw new BoundedJsonError("JSON response exceeded the maximum node count.");
	}

	if (Array.isArray(value)) {
		if (state.depth >= opts.maxDepth) {
			throw new BoundedJsonError("JSON response exceeded the maximum nesting depth.");
		}
		if (value.length > opts.maxArrayItems) {
			throw new BoundedJsonError("JSON response contained an array that exceeded the maximum length.");
		}
		state.depth += 1;
		for (const item of value) assertBoundedJson(item, opts, state);
		state.depth -= 1;
		return;
	}

	if (value !== null && typeof value === "object") {
		if (state.depth >= opts.maxDepth) {
			throw new BoundedJsonError("JSON response exceeded the maximum nesting depth.");
		}
		const keys = Object.keys(value as Record<string, unknown>);
		if (keys.length > opts.maxObjectKeys) {
			throw new BoundedJsonError("JSON response contained an object that exceeded the maximum key count.");
		}
		state.depth += 1;
		for (const k of keys) {
			assertBoundedJson((value as Record<string, unknown>)[k], opts, state);
		}
		state.depth -= 1;
	}
}

/**
 * Parse JSON and assert the result fits the bounds.
 *
 * Throws `BoundedJsonError` for either invalid JSON (the underlying SyntaxError
 * is wrapped so callers have one error type to catch) or a value that exceeds
 * any limit.
 */
export function parseBoundedJson(text: string, options: BoundedJsonOptions = {}): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		throw new BoundedJsonError(
			`JSON response was not parseable: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
	assertBoundedJson(parsed, options);
	return parsed;
}

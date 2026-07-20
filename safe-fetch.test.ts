import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BoundedJsonError,
	type BoundedJsonOptions,
} from "./bounded-json.js";
import {
	RedirectError,
	ResponseSizeError,
	readBoundedJson,
	readBoundedText,
	safeFetch,
} from "./safe-fetch.js";

describe("safeFetch", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.restoreAllMocks();
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns the response for a normal 2xx request", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response("ok", { status: 200 }),
		) as typeof fetch;

		const res = await safeFetch("https://auth.x.ai/oauth/token");
		expect(res.status).toBe(200);
	});

	it("returns the response for a 4xx error (the caller decides how to surface it)", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response("bad", { status: 400 }),
		) as typeof fetch;

		const res = await safeFetch("https://auth.x.ai/oauth/token");
		expect(res.status).toBe(400);
	});

	for (const status of [301, 302, 303, 307, 308]) {
		it(`throws RedirectError on a ${status} response`, async () => {
			globalThis.fetch = vi.fn(async () =>
				new Response("", { status, headers: { Location: "https://evil.example/leak" } }),
			) as typeof fetch;

			await expect(safeFetch("https://auth.x.ai/oauth/token")).rejects.toBeInstanceOf(RedirectError);
		});
	}

	it("includes the redirect target in the error message", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response("", { status: 302, headers: { Location: "https://evil.example/leak" } }),
		) as typeof fetch;

		try {
			await safeFetch("https://auth.x.ai/oauth/token");
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(RedirectError);
			expect((e as RedirectError).message).toContain("https://evil.example/leak");
		}
	});

	it("still rejects when the response carries no Location header", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response("", { status: 302 }),
		) as typeof fetch;

		await expect(safeFetch("https://auth.x.ai/oauth/token")).rejects.toBeInstanceOf(RedirectError);
	});

	it("passes through fetch options (method, headers, body, signal)", async () => {
		const calls: unknown[] = [];
		globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
			calls.push({ input, init });
			return new Response("ok", { status: 200 });
		}) as typeof fetch;

		const controller = new AbortController();
		await safeFetch("https://auth.x.ai/oauth/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "code=AC&verifier=V",
			signal: controller.signal,
		});

		expect(calls).toHaveLength(1);
		const init = (calls[0] as { init: RequestInit }).init;
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
		expect(init.body).toBe("code=AC&verifier=V");
		// redirect: manual is forced on by safeFetch.
		expect(init.redirect).toBe("manual");
	});

	it("forces redirect: manual even when the caller asks for follow", async () => {
		const calls: unknown[] = [];
		globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
			calls.push({ input, init });
			return new Response("ok", { status: 200 });
		}) as typeof fetch;

		await safeFetch("https://auth.x.ai/oauth/token", { redirect: "follow" });

		const init = (calls[0] as { init: RequestInit }).init;
		expect(init.redirect).toBe("manual");
	});

	it("propagates a network failure (wraps nothing)", async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error("network down");
		}) as typeof fetch;

		await expect(safeFetch("https://auth.x.ai/oauth/token")).rejects.toThrow("network down");
	});
});

describe("RedirectError", () => {
	it("carries the location string", () => {
		const err = new RedirectError("https://evil.example/leak");
		expect(err.location).toBe("https://evil.example/leak");
		expect(err.message).toContain("https://evil.example/leak");
	});

	it("is named RedirectError", () => {
		expect(new RedirectError("x").name).toBe("RedirectError");
	});
});

// ─── readBoundedText ─────────────────────────────────────────────────────────

describe("readBoundedText", () => {
	it("returns the full body when it fits under the cap", async () => {
		const res = new Response("hello world", { status: 200 });
		await expect(readBoundedText(res, 1024)).resolves.toBe("hello world");
	});

	it("returns the body when its length equals the cap", async () => {
		const res = new Response("abc", { status: 200 });
		await expect(readBoundedText(res, 3)).resolves.toBe("abc");
	});

	it("throws ResponseSizeError when the body exceeds the cap", async () => {
		const res = new Response("hello world", { status: 200 });
		await expect(readBoundedText(res, 5)).rejects.toBeInstanceOf(ResponseSizeError);
	});

	it("exposes the configured maxBytes on the error", async () => {
		const res = new Response("x".repeat(100), { status: 200 });
		try {
			await readBoundedText(res, 16);
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ResponseSizeError);
			expect((e as ResponseSizeError).maxBytes).toBe(16);
		}
	});

	it("rejects a body that is not valid UTF-8", async () => {
		// 0xff is invalid as the first byte of a UTF-8 sequence.
		const res = new Response(new Uint8Array([0xff, 0xfe]), { status: 200 });
		await expect(readBoundedText(res, 1024)).rejects.toThrow();
	});

	it("streams a chunked body and caps as soon as the cap is crossed", async () => {
		// Build a streaming body that emits two chunks; the second one pushes
		// the total past the cap so the read must reject mid-stream.
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("four"));
				controller.enqueue(encoder.encode("more"));
				controller.close();
			},
		});
		const res = new Response(stream, { status: 200 });
		// "four" alone is 4 bytes; total after "more" is 8. Cap at 6 trips it.
		await expect(readBoundedText(res, 6)).rejects.toBeInstanceOf(ResponseSizeError);
	});

	it("counts bytes, not characters, on the no-stream fallback path (multibyte)", async () => {
		// A Response without a streaming body (partial mock) falls through to
		// response.text(). The cap must count UTF-8 bytes, not JS character
		// count, so multibyte input is held to the same ceiling as the stream.
		// Each '\u00e9' is 2 UTF-8 bytes but 1 JS char: 10 chars = 20 bytes.
		const text = "\u00e9".repeat(10);
		const res = { text: async () => text } as unknown as Response;
		// 15-byte cap: passes by char count (10), fails by byte count (20).
		await expect(readBoundedText(res, 15)).rejects.toBeInstanceOf(ResponseSizeError);
		// 20-byte cap: exactly fits.
		await expect(readBoundedText({ text: async () => text } as unknown as Response, 20)).resolves.toBe(text);
	});
});

// ─── readBoundedJson ─────────────────────────────────────────────────────────

describe("readBoundedJson", () => {
	const opts: BoundedJsonOptions = { maxDepth: 4, maxNodes: 64, maxArrayItems: 8, maxObjectKeys: 8 };

	it("parses a small JSON body that fits the byte and shape caps", async () => {
		const res = new Response(JSON.stringify({ a: 1, b: [2, 3] }), { status: 200 });
		await expect(readBoundedJson(res, 1024, opts)).resolves.toEqual({ a: 1, b: [2, 3] });
	});

	it("throws ResponseSizeError before parsing when the body is too large", async () => {
		const res = new Response("x".repeat(100), { status: 200 });
		await expect(readBoundedJson(res, 16, opts)).rejects.toBeInstanceOf(ResponseSizeError);
	});

	it("throws BoundedJsonError when the body parses but exceeds the shape caps", async () => {
		// Valid JSON, but nested deeper than maxDepth=4.
		let deep: unknown = { v: 1 };
		for (let i = 0; i < 10; i++) deep = { nested: deep };
		const res = new Response(JSON.stringify(deep), { status: 200 });
		await expect(readBoundedJson(res, 1024, opts)).rejects.toBeInstanceOf(BoundedJsonError);
	});

	it("throws BoundedJsonError on invalid JSON", async () => {
		const res = new Response("{not json", { status: 200 });
		await expect(readBoundedJson(res, 1024, opts)).rejects.toBeInstanceOf(BoundedJsonError);
	});
});

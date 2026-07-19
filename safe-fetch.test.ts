import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedirectError, safeFetch } from "./safe-fetch.js";

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

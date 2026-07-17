import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProxyHeaders } from "./models.js";
import { XSearchHttpError, callXSearch } from "./x-search-tool.js";

const OK_RESPONSE = {
	output: [
		{
			type: "message",
			content: [{ type: "output_text", text: "post about cats" }],
		},
	],
	citations: [{ url: "https://x.com/1", title: "Cats" }],
};

function mockFetchOk(body: unknown) {
	return vi.fn().mockResolvedValue({
		ok: true,
		json: async () => body,
	} as unknown as Response);
}

function mockFetchStatus(status: number, body = "") {
	return vi.fn().mockResolvedValue({
		ok: false,
		status,
		text: async () => body,
	} as unknown as Response);
}

describe("callXSearch", () => {
	const realFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = realFetch;
		vi.restoreAllMocks();
	});

	it("sends a POST to the proxy /responses with bearer + proxy headers", async () => {
		const fetchMock = mockFetchOk(OK_RESPONSE);
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		await callXSearch("tok", "https://cli-chat-proxy.grok.com/v1", "cats");

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
		expect(init.method).toBe("POST");
		expect(init.headers.Authorization).toBe("Bearer tok");
		expect(init.headers["X-XAI-Token-Auth"]).toBe(buildProxyHeaders()["X-XAI-Token-Auth"]);
		// The search model is carried as the proxy's model-override header.
		expect(init.headers["x-grok-model-override"]).toBe(
			process.env.PI_XAI_X_SEARCH_MODEL ?? "grok-4.5",
		);
	});

	it("extracts answer text and citations", async () => {
		globalThis.fetch = mockFetchOk(OK_RESPONSE) as unknown as typeof globalThis.fetch;
		const result = await callXSearch("tok", "https://p/v1", "cats");
		expect(result.answer).toBe("post about cats");
		expect(result.citations).toEqual([{ url: "https://x.com/1", title: "Cats" }]);
	});

	it("throws XSearchHttpError carrying the status on a non-ok response", async () => {
		globalThis.fetch = mockFetchStatus(500, "boom") as unknown as typeof globalThis.fetch;
		await expect(callXSearch("tok", "https://p/v1", "cats")).rejects.toMatchObject({
			name: "XSearchHttpError",
			status: 500,
		});
	});

	it("reports status 401 on auth failure so the handler can map it", async () => {
		globalThis.fetch = mockFetchStatus(401, "unauthorized") as unknown as typeof globalThis.fetch;
		const err = await callXSearch("tok", "https://p/v1", "cats").catch((e) => e);
		expect(err).toBeInstanceOf(XSearchHttpError);
		expect((err as XSearchHttpError).status).toBe(401);
	});

	it("returns (no results) when no output_text is present", async () => {
		globalThis.fetch = mockFetchOk({ output: [] }) as unknown as typeof globalThis.fetch;
		const result = await callXSearch("tok", "https://p/v1", "cats");
		expect(result.answer).toBe("(no results)");
		expect(result.citations).toBeUndefined();
	});
});

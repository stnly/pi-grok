/**
 * Fetch wrappers that harden the request and response paths for authenticated
 * xAI calls.
 *
 * `safeFetch` rejects HTTP redirects so credentials in the Authorization
 * header or body can't be replayed to an attacker-controlled origin.
 *
 * `readBoundedText` and `readBoundedJson` cap the response body size while
 * it is still streaming, so a hostile or buggy pinned origin can't hang the
 * request or exhaust memory by sending a pathological body. `readBoundedJson`
 * additionally walks the parsed value through the bounded-JSON walker so a
 * pathological shape (deeply nested, huge arrays) can't blow the stack.
 */

import { parseBoundedJson, type BoundedJsonOptions } from "./bounded-json.js";

/** Error thrown when an xAI request was redirected. */
export class RedirectError extends Error {
	constructor(public readonly location: string) {
		super(`xAI request was redirected: ${location}`);
		this.name = "RedirectError";
	}
}

/** Error thrown when a response body exceeds the documented byte ceiling. */
export class ResponseSizeError extends Error {
	constructor(public readonly maxBytes: number) {
		super(`xAI response exceeded the ${maxBytes}-byte limit.`);
		this.name = "ResponseSizeError";
	}
}

/**
 * Fetch with `redirect: "manual"` and reject any 3xx response.
 *
 * The caller still owns the rest of the request shape (method, headers, body,
 * signal, timeout). A non-redirect response is returned verbatim, including
 * 4xx and 5xx, so existing error-handling logic is unchanged.
 */
export async function safeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const response = await fetch(input, { ...init, redirect: "manual" });
	if (response.status >= 300 && response.status < 400) {
		throw new RedirectError(response.headers.get("location") ?? "(no location header)");
	}
	return response;
}

/**
 * Read the response body as text with a streaming byte cap.
 *
 * Streams the body chunk-by-chunk and rejects as soon as the cumulative size
 * crosses `maxBytes`, cancelling the underlying stream so a hostile endpoint
 * can't keep writing. Falls back to `response.text()` for Response objects
 * without a streaming body (eg. the in-memory Response that vitest mocks
 * produce); the cap still applies post-hoc in that case.
 *
 * Uses `TextDecoder({ fatal: true })` so invalid UTF-8 throws rather than
 * producing silent replacement characters that could mask a malformed body.
 */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
	const stream = response.body;
	if (!stream) {
		const text = await response.text();
		if (text.length > maxBytes) throw new ResponseSizeError(maxBytes);
		return text;
	}

	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let received = 0;
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > maxBytes) {
				try { await reader.cancel().catch(() => undefined); } catch { /* best effort */ }
				throw new ResponseSizeError(maxBytes);
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		try { reader.releaseLock(); } catch { /* hostile pending read may hold the lock */ }
	}
}

/**
 * Read and parse a JSON response body with both a streaming byte cap and a
 * bounded-JSON walk on the parsed value.
 *
 * Composes `readBoundedText` (size cap, fatal UTF-8) with `parseBoundedJson`
 * (depth/node/array/key ceilings) so neither a pathological body nor a
 * pathological JSON shape can exhaust memory or stack. Callers should pass
 * the shared `BOUNDED_JSON_OPTIONS`-style ceiling appropriate to the surface.
 */
export async function readBoundedJson(
	response: Response,
	maxBytes: number,
	options: BoundedJsonOptions = {},
): Promise<unknown> {
	const text = await readBoundedText(response, maxBytes);
	return parseBoundedJson(text, options);
}

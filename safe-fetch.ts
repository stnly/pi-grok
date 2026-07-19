/**
 * Fetch wrapper that rejects HTTP redirects.
 *
 * Every authenticated xAI request (OIDC discovery, token exchange, refresh,
 * account/privacy lookups, billing, search) carries credentials, refresh
 * tokens, or OAuth codes in either the Authorization header or the body. If
 * the upstream endpoint returns a 3xx, `fetch` with the default `redirect:
 * "follow"` would replay the request, credentials included, to whatever
 * location the server points at. A compromised or MITM'd endpoint could use
 * that to exfiltrate tokens.
 *
 * `safeFetch` sets `redirect: "manual"` and rejects any 3xx response before
 * the body is read, so the caller can never mistake a redirect for a normal
 * response and the credentials never leave the original origin.
 */

/** Error thrown when an xAI request was redirected. */
export class RedirectError extends Error {
	constructor(public readonly location: string) {
		super(`xAI request was redirected: ${location}`);
		this.name = "RedirectError";
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

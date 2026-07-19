import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fetchJwks,
	getCachedJwks,
	resetJwksCacheForTests,
	verifyIdTokenSignature,
} from "./oauth.js";
import { XaiErrorCode, XaiOAuthError } from "./errors.js";

// ─── Test key material ──────────────────────────────────────────────────────

/**
 * Generate an ECDSA P-256 key pair and a helper that signs the JWT
 * signing input (`header.payload`) using the webcrypto ECDSA primitive.
 *
 * JWT signatures for ES256 are the raw R||S concatenation, which is the
 * format SubtleCrypto.sign produces when invoked with `{ name: "ECDSA",
 * hash: "SHA-256" }` and a P-256 key, so no DER conversion is required.
 */
async function makeKey(): Promise<{
	jwk: JsonWebKey;
	sign: (headerB64: string, payloadB64: string) => Promise<string>;
}> {
	const pair = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	);
	const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
	const sign = async (headerB64: string, payloadB64: string) => {
		const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
		const sig = await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			pair.privateKey,
			data,
		);
		return bufferToB64url(sig);
	};
	return { jwk, sign };
}

function bufferToB64url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64url(obj: unknown): string {
	return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Build a complete signed JWT for tests. */
async function signedJwt(
	sign: (h: string, p: string) => Promise<string>,
	header: Record<string, unknown>,
	payload: Record<string, unknown>,
): Promise<string> {
	const h = b64url(header);
	const p = b64url(payload);
	const s = await sign(h, p);
	return `${h}.${p}.${s}`;
}

// ─── JWKS cache ─────────────────────────────────────────────────────────────

const JWKS_URI = "https://auth.x.ai/.well-known/jwks.json";

describe("fetchJwks / getCachedJwks", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.restoreAllMocks();
		resetJwksCacheForTests();
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		resetJwksCacheForTests();
	});

	it("fetches the JWKS once and caches the result", async () => {
		let calls = 0;
		globalThis.fetch = vi.fn(async () => {
			calls++;
			return new Response(JSON.stringify({ keys: [{ kty: "EC", crv: "P-256", x: "a", y: "b", kid: "k1", alg: "ES256" }] }), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const a = await fetchJwks(JWKS_URI);
		const b = await fetchJwks(JWKS_URI);
		expect(calls).toBe(1);
		expect(a).toBe(b);
		expect(a[0]?.kid).toBe("k1");
	});

	it("rejects a non-xAI JWKS URI", async () => {
		await expect(fetchJwks("https://evil.example/jwks.json")).rejects.toMatchObject({
			code: XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
		});
	});

	it("rejects a JWKS response that is not application/json", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response("<html/>", { status: 200, headers: { "Content-Type": "text/html" } }),
		) as typeof fetch;
		await expect(fetchJwks(JWKS_URI)).rejects.toMatchObject({
			code: XaiErrorCode.ID_TOKEN_INVALID,
		});
	});

	it("accepts application/jwk-set+json as a JWKS content type", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ keys: [{ kty: "EC", crv: "P-256", x: "a", y: "b", kid: "k1" }] }), {
				status: 200, headers: { "Content-Type": "application/jwk-set+json" },
			}),
		) as typeof fetch;
		const keys = await fetchJwks(JWKS_URI);
		expect(keys[0]?.kid).toBe("k1");
	});

	it("rejects a JWKS response without a keys array", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ not_keys: [] }), {
				status: 200, headers: { "Content-Type": "application/json" },
			}),
		) as typeof fetch;
		await expect(fetchJwks(JWKS_URI)).rejects.toMatchObject({
			code: XaiErrorCode.ID_TOKEN_INVALID,
		});
	});

	it("drops JWKs that look like private keys (carry a d field)", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ keys: [
				{ kty: "EC", crv: "P-256", x: "a", y: "b", d: "secret", kid: "k1" },
				{ kty: "EC", crv: "P-256", x: "c", y: "d", kid: "k2" },
			] }), {
				status: 200, headers: { "Content-Type": "application/json" },
			}),
		) as typeof fetch;

		const keys = await fetchJwks(JWKS_URI);
		expect(keys.map((k) => k.kid)).toEqual(["k2"]);
	});

	it("does not cache a failed fetch", async () => {
		let calls = 0;
		globalThis.fetch = vi.fn(async () => {
			calls++;
			return new Response("nope", { status: 503 });
		}) as typeof fetch;

		await expect(fetchJwks(JWKS_URI)).rejects.toBeTruthy();
		await expect(fetchJwks(JWKS_URI)).rejects.toBeTruthy();
		expect(calls).toBe(2);
	});

	it("getCachedJwks returns null when no fetch has run", async () => {
		expect(getCachedJwks()).toBeNull();
	});
});

// ─── verifyIdTokenSignature ─────────────────────────────────────────────────

describe("verifyIdTokenSignature", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.restoreAllMocks();
		resetJwksCacheForTests();
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		resetJwksCacheForTests();
	});

	it("accepts a token signed by a key in the JWKS", async () => {
		const { jwk, sign } = await makeKey();
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1", alg: "ES256" }] }), {
				status: 200, headers: { "Content-Type": "application/json" },
			}),
		) as typeof fetch;

		const token = await signedJwt(sign, { alg: "ES256", kid: "k1" }, { sub: "u1" });
		await expect(verifyIdTokenSignature(token, JWKS_URI)).resolves.toBeUndefined();
	});

	it("accepts a token with no kid when the JWKS has a single matching key", async () => {
		const { jwk, sign } = await makeKey();
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ keys: [{ ...jwk, alg: "ES256" }] }), {
				status: 200, headers: { "Content-Type": "application/json" },
			}),
		) as typeof fetch;

		const token = await signedJwt(sign, { alg: "ES256" }, { sub: "u1" });
		await expect(verifyIdTokenSignature(token, JWKS_URI)).resolves.toBeUndefined();
	});

	it("rejects a token signed by a different key than the JWKS carries", async () => {
		const good = await makeKey();
		const bad = await makeKey();
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ keys: [{ ...good.jwk, kid: "k1", alg: "ES256" }] }), {
				status: 200, headers: { "Content-Type": "application/json" },
			}),
		) as typeof fetch;

		// Sign with bad, JWKS exposes good: verification must fail.
		const token = await signedJwt(bad.sign, { alg: "ES256", kid: "k1" }, { sub: "u1" });
		await expect(verifyIdTokenSignature(token, JWKS_URI)).rejects.toMatchObject({
			code: XaiErrorCode.ID_TOKEN_SIGNATURE_INVALID,
		});
	});

	it("rejects an alg other than ES256", async () => {
		const { jwk, sign } = await makeKey();
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1", alg: "ES256" }] }), {
				status: 200, headers: { "Content-Type": "application/json" },
			}),
		) as typeof fetch;

		const token = await signedJwt(sign, { alg: "RS256", kid: "k1" }, { sub: "u1" });
		await expect(verifyIdTokenSignature(token, JWKS_URI)).rejects.toMatchObject({
			code: XaiErrorCode.ID_TOKEN_INVALID,
		});
	});

	it("rejects a header carrying crit/jku/jwk/x5u extensions", async () => {
		const { jwk, sign } = await makeKey();
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1", alg: "ES256" }] }), {
				status: 200, headers: { "Content-Type": "application/json" },
			}),
		) as typeof fetch;

		for (const extra of [{ crit: ["exp"] }, { jku: "https://x/jwks" }, { jwk: {} }, { x5u: "https://x/cert" }, { b64: false }]) {
			const token = await signedJwt(sign, { alg: "ES256", kid: "k1", ...extra }, { sub: "u1" });
			await expect(verifyIdTokenSignature(token, JWKS_URI)).rejects.toMatchObject({
				code: XaiErrorCode.ID_TOKEN_INVALID,
			});
		}
	});

	it("rejects a non-JWT input", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ keys: [] }), {
				status: 200, headers: { "Content-Type": "application/json" },
			}),
		) as typeof fetch;

		await expect(verifyIdTokenSignature("not-a-jwt", JWKS_URI)).rejects.toMatchObject({
			code: XaiErrorCode.ID_TOKEN_INVALID,
		});
	});

	it("rejects a kid that does not match any key in the JWKS after a forced re-fetch", async () => {
		const { jwk, sign } = await makeKey();
		let calls = 0;
		globalThis.fetch = vi.fn(async () => {
			calls++;
			return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1", alg: "ES256" }] }), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const token = await signedJwt(sign, { alg: "ES256", kid: "unknown" }, { sub: "u1" });
		await expect(verifyIdTokenSignature(token, JWKS_URI)).rejects.toMatchObject({
			code: XaiErrorCode.ID_TOKEN_SIGNATURE_INVALID,
		});
		// Cache miss on kid forces one re-fetch, then fails.
		expect(calls).toBe(2);
	});

	it("re-fetches the JWKS once when the cached set misses the token kid", async () => {
		const oldKey = await makeKey();
		const newKey = await makeKey();
		let calls = 0;
		globalThis.fetch = vi.fn(async () => {
			calls++;
			const keys = calls === 1
				? [{ ...oldKey.jwk, kid: "old", alg: "ES256" }]
				: [{ ...oldKey.jwk, kid: "old", alg: "ES256" }, { ...newKey.jwk, kid: "new", alg: "ES256" }];
			return new Response(JSON.stringify({ keys }), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		// Warm the cache with the old key only.
		await fetchJwks(JWKS_URI);
		expect(calls).toBe(1);

		// Token carries the rotated kid; verify must force-refresh and succeed.
		const token = await signedJwt(newKey.sign, { alg: "ES256", kid: "new" }, { sub: "u1" });
		await expect(verifyIdTokenSignature(token, JWKS_URI)).resolves.toBeUndefined();
		expect(calls).toBe(2);
	});

	it("rejects a tampered payload (signature no longer matches)", async () => {
		const { jwk, sign } = await makeKey();
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1", alg: "ES256" }] }), {
				status: 200, headers: { "Content-Type": "application/json" },
			}),
		) as typeof fetch;

		const token = await signedJwt(sign, { alg: "ES256", kid: "k1" }, { sub: "u1" });
		// Flip a bit in the payload without re-signing.
		const [h, _p, s] = token.split(".");
		const tampered = `${h}.${b64url({ sub: "attacker" })}.${s}`;
		await expect(verifyIdTokenSignature(tampered, JWKS_URI)).rejects.toMatchObject({
			code: XaiErrorCode.ID_TOKEN_SIGNATURE_INVALID,
		});
	});
});

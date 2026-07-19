import { describe, expect, it } from "vitest";
import {
	CATALOG_CACHE_SCHEMA_VERSION,
	CATALOG_FRESH_TTL_MS,
	CATALOG_MAX_STALE_MS,
	loadCachedCatalog,
	serializeCatalog,
} from "./catalog-cache.js";

describe("serializeCatalog / loadCachedCatalog", () => {
	it("round-trips a fetched body with a fetchedAt timestamp", () => {
		const fetchedAt = 1_700_000_000_000;
		const text = serializeCatalog({ data: [{ id: "grok-4.5" }] }, fetchedAt);
		const result = loadCachedCatalog(text, { fetchedAt: 0, now: fetchedAt + 1000 });
		expect(result?.body).toEqual({ data: [{ id: "grok-4.5" }] });
		expect(result?.fetchedAt).toBe(fetchedAt);
		expect(result?.source).toBe("fresh-cache");
	});

	it("labels a fresh cache as fresh-cache", () => {
		const now = 2_000_000_000_000;
		const text = serializeCatalog({ data: [] }, now - 60_000);
		const result = loadCachedCatalog(text, { fetchedAt: 0, now });
		expect(result?.source).toBe("fresh-cache");
	});

	it("labels a stale-but-not-expired cache as stale-cache", () => {
		const now = 2_000_000_000_000;
		const fetchedAt = now - CATALOG_FRESH_TTL_MS - 1;
		const text = serializeCatalog({ data: [] }, fetchedAt);
		const result = loadCachedCatalog(text, { fetchedAt: 0, now });
		expect(result?.source).toBe("stale-cache");
	});

	it("returns null when the cache is older than the stale window", () => {
		const now = 2_000_000_000_000;
		const fetchedAt = now - CATALOG_MAX_STALE_MS - 1;
		const text = serializeCatalog({ data: [] }, fetchedAt);
		const result = loadCachedCatalog(text, { fetchedAt: 0, now });
		expect(result).toBeNull();
	});

	it("accepts a catalog data array larger than the shared default maxArrayItems", () => {
		// Shared defaults cap arrays at 64; a real /models list can grow past that.
		// Catalog load must use its own ceiling so cold starts still adopt the body.
		const data = Array.from({ length: 100 }, (_, i) => ({ id: `grok-${i}` }));
		const now = 2_000_000_000_000;
		const text = serializeCatalog({ data }, now);
		const result = loadCachedCatalog(text, { fetchedAt: 0, now });
		expect(result?.body).toEqual({ data });
		expect(result?.source).toBe("fresh-cache");
	});

	it("returns null for an empty string", () => {
		expect(loadCachedCatalog("", { fetchedAt: 0, now: 0 })).toBeNull();
	});

	it("returns null for non-JSON content", () => {
		expect(loadCachedCatalog("not json", { fetchedAt: 0, now: 0 })).toBeNull();
	});

	it("returns null for JSON that is not an object", () => {
		expect(loadCachedCatalog("[1,2,3]", { fetchedAt: 0, now: 0 })).toBeNull();
	});

	it("returns null when the schema version does not match", () => {
		const text = JSON.stringify({
			schemaVersion: CATALOG_CACHE_SCHEMA_VERSION + 1,
			fetchedAt: Date.now(),
			body: { data: [] },
		});
		expect(loadCachedCatalog(text, { fetchedAt: 0, now: Date.now() })).toBeNull();
	});

	it("returns null when fetchedAt is missing or non-numeric", () => {
		const text = JSON.stringify({
			schemaVersion: CATALOG_CACHE_SCHEMA_VERSION,
			body: { data: [] },
		});
		expect(loadCachedCatalog(text, { fetchedAt: 0, now: Date.now() })).toBeNull();
	});

	it("returns null when body is missing or not an object", () => {
		const text = JSON.stringify({
			schemaVersion: CATALOG_CACHE_SCHEMA_VERSION,
			fetchedAt: Date.now(),
			body: "not-an-object",
		});
		expect(loadCachedCatalog(text, { fetchedAt: 0, now: Date.now() })).toBeNull();
	});

	it("returns null when the serialized object is pathologically deep", () => {
		// Build a deep body that exceeds the bounded-JSON default depth. The
		// parser must reject it rather than blow the stack.
		let body: unknown = { id: "deep" };
		for (let i = 0; i < 50; i++) body = { nested: body };
		const text = serializeCatalog(body, Date.now());
		expect(loadCachedCatalog(text, { fetchedAt: 0, now: Date.now() })).toBeNull();
	});

	it("returns null for a fetchedAt from the future (clock-skewed past plausible)", () => {
		// A fetchedAt 100 years in the future is not a real timestamp.
		const text = serializeCatalog({ data: [] }, Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
		expect(loadCachedCatalog(text, { fetchedAt: 0, now: Date.now() })).toBeNull();
	});
});

/**
 * On-disk cache for the live xAI model catalog.
 *
 * The OAuth session's `/models` lookup is enrichment only, and routing never
 * depends on it, so a missing or stale cache is always safe to fall back from.
 * The cache exists so a cold pi start doesn't have to wait on a proxy fetch
 * before the model picker can show context windows or newly released ids: if a
 * fresh body is on disk we use it immediately, and if the body is stale we use
 * it as a placeholder while a background refresh runs.
 *
 * The file holds no credentials and no account identity. The body is exactly
 * what came back from `/models`, and the wrapper carries a schema version and
 * the fetch timestamp. Reads parse defensively: any malformed, oversized, or
 * schema-mismatched file is treated as a miss, never thrown.
 */

import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parseBoundedJson, type BoundedJsonOptions } from "./bounded-json.js";

/** Bumped whenever the on-disk shape changes. Older files are ignored. */
export const CATALOG_CACHE_SCHEMA_VERSION = 1;

/** A cache fetched within this window is used without a background refresh. */
export const CATALOG_FRESH_TTL_MS = 15 * 60 * 1000;

/** A cache older than fresh but within this window is used while refreshing. */
export const CATALOG_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Reject any fetchedAt more than this far in the future: not a real timestamp. */
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Bounds for a catalog body (live fetch or on-disk cache).
 *
 * Wider than the shared defaults: `/models` is a flat list of entries and can
 * grow past the 64-item default array ceiling without being pathological.
 */
export const CATALOG_BOUNDED_JSON_OPTIONS: Required<BoundedJsonOptions> = {
	maxDepth: 8,
	maxNodes: 16_384,
	maxArrayItems: 512,
	maxObjectKeys: 64,
};

export type CatalogCacheSource = "fresh-cache" | "stale-cache";

export interface CatalogCacheRecord {
	schemaVersion: number;
	fetchedAt: number;
	body: unknown;
}

export interface LoadedCatalog {
	body: unknown;
	fetchedAt: number;
	/** "fresh-cache" inside the TTL, "stale-cache" inside the stale window. */
	source: CatalogCacheSource;
}

/**
 * Serialize a catalog body for atomic write.
 *
 * The body is stored verbatim so a FALLBACK_MODELS change re-merges without a
 * refetch. The schema version is written alongside so a future shape change
 * makes old files ignored without a parse error.
 */
export function serializeCatalog(body: unknown, fetchedAt: number): string {
	const record: CatalogCacheRecord = {
		schemaVersion: CATALOG_CACHE_SCHEMA_VERSION,
		fetchedAt,
		body,
	};
	return JSON.stringify(record);
}

/**
 * Parse and validate a cache file's contents.
 *
 * Returns null for any failure: missing fields, schema mismatch, malformed
 * JSON, pathological nesting, or a fetchedAt too far in the future. The
 * bounded-JSON parser caps depth and breadth so a tampered or buggy write
 * can't exhaust the stack.
 */
export function loadCachedCatalog(
	text: string,
	opts: { fetchedAt: number; now: number },
): LoadedCatalog | null {
	if (!text) return null;

	let parsed: unknown;
	try {
		// The on-disk envelope is small; the body may hold a long model list, so
		// use the catalog ceilings rather than the shared defaults.
		parsed = parseBoundedJson(text, CATALOG_BOUNDED_JSON_OPTIONS);
	} catch {
		return null;
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const record = parsed as Partial<CatalogCacheRecord>;
	if (record.schemaVersion !== CATALOG_CACHE_SCHEMA_VERSION) return null;
	if (typeof record.fetchedAt !== "number" || !Number.isFinite(record.fetchedAt)) return null;
	if (record.body === undefined || record.body === null || typeof record.body !== "object") return null;

	// Reject implausible timestamps: too far in the future means a clock-skewed
	// or tampered cache, too old means the stale window has passed.
	const now = opts.now;
	const fetchedAt = record.fetchedAt;
	if (fetchedAt > now + MAX_FUTURE_SKEW_MS) return null;
	const ageMs = now - fetchedAt;
	if (ageMs > CATALOG_MAX_STALE_MS) return null;

	// If the caller passed an existing in-memory fetchedAt, the on-disk record
	// must be strictly newer to be worth adopting; otherwise the in-memory
	// state (which may already reflect a fresher successful fetch) wins.
	if (opts.fetchedAt && fetchedAt < opts.fetchedAt) return null;

	const source: CatalogCacheSource = ageMs > CATALOG_FRESH_TTL_MS ? "stale-cache" : "fresh-cache";

	return { body: record.body, fetchedAt, source };
}

/**
 * Atomically write the cache file.
 *
 * Writes to a sibling temp file and renames into place so a crash mid-write
 * leaves either the previous file intact or the new file whole, never a
 * truncated mix. Errors are swallowed: a cache write failure is not a login
 * failure, and the next successful fetch will try again.
 */
export async function writeCachedCatalog(
	cachePath: string,
	body: unknown,
	fetchedAt: number,
): Promise<void> {
	// Empty path means the agent directory could not be resolved (tests outside
	// a pi install, embed without getAgentDir). Skip rather than mkdir(".") and
	// writing a temp file next to the process cwd.
	if (!cachePath) return;

	const text = serializeCatalog(body, fetchedAt);
	// Two concurrent fetches (re-login then token rotation within the same tick,
	// or a superseded-but-still-running discovery worker) can both reach the
	// write step. process.pid disambiguates across processes but not within
	// one, so a per-call random suffix keeps the temp files distinct and the
	// final rename lands a whole file rather than a truncate-then-rename mix.
	const tmpPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await mkdir(dirname(cachePath), { recursive: true });
		await writeFile(tmpPath, text, { mode: 0o600 });
		await rename(tmpPath, cachePath);
	} catch {
		try { await unlink(tmpPath); } catch { /* best effort */ }
	}
}

/**
 * Client version label sent to the cli-chat-proxy.
 *
 * The proxy rejects a version it does not admit, and the accepted floor moves
 * as xAI ships grok-shell releases. The install script reads the current
 * version from a channel pointer, so this does the same: `https://x.ai/cli/stable`
 * first, then the GCS bucket the installer falls back to. The pointer returns
 * one line, `X.Y.Z` or `X.Y.Z-suffix`.
 *
 * The resolved version is cached in `version.json` so a later request, and a
 * later pi launch, sends it without waiting on the network. A request never
 * blocks on the fetch. It sends the cached version, or the shipped floor when
 * the cache is empty, and refreshes in the background once the cache is older
 * than a day. A fetched version older than the shipped floor is ignored, so a
 * stale pointer cannot downgrade a version the proxy already accepts.
 *
 * `PI_XAI_CLIENT_VERSION` overrides all of this and skips the fetch.
 */

import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readBoundedText, safeFetch } from "./safe-fetch.js";

/** Shipped floor. Used when the cache is empty and no fetch has succeeded. */
export const CLIENT_VERSION_FLOOR = "1.0.46";

/** A cached version younger than this is sent without a background refresh. */
export const CLIENT_VERSION_TTL_MS = 24 * 60 * 60 * 1000;

const VERSION_URLS = [
	"https://x.ai/cli/stable",
	"https://storage.googleapis.com/grok-build-public-artifacts/cli/stable",
];

/** The pointer is one short line. Anything larger is not a version. */
const MAX_POINTER_BYTES = 256;

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._]+)?$/;

interface VersionRecord {
	version: string;
	fetchedAt: number;
}

function versionCachePath(): string {
	try {
		return join(getAgentDir(), "cache", "pi-grok", "version.json");
	} catch {
		return "";
	}
}

/** Compare `X.Y.Z` numerically by major, minor, patch. A suffix is newer than the bare release. */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) => {
		const [core, suffix] = v.split(/-(.*)/, 2) as [string, string?];
		const [major, minor, patch] = core.split(".").map(Number);
		return { major, minor, patch, suffix };
	};
	const av = parse(a);
	const bv = parse(b);
	const diff = av.major - bv.major || av.minor - bv.minor || av.patch - bv.patch;
	if (diff !== 0) return diff;
	if (av.suffix === bv.suffix) return 0;
	if (av.suffix === undefined) return -1;
	if (bv.suffix === undefined) return 1;
	return av.suffix < bv.suffix ? -1 : 1;
}

function readCache(path: string): VersionRecord | null {
	if (!path) return null;
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(text) as Partial<VersionRecord>;
		if (typeof parsed.version !== "string" || !VERSION_RE.test(parsed.version)) return null;
		if (typeof parsed.fetchedAt !== "number" || !Number.isFinite(parsed.fetchedAt)) return null;
		if (compareVersions(parsed.version, CLIENT_VERSION_FLOOR) <= 0) return null;
		return { version: parsed.version, fetchedAt: parsed.fetchedAt };
	} catch {
		return null;
	}
}

async function writeCache(path: string, record: VersionRecord): Promise<void> {
	if (!path) return;
	const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(tmpPath, JSON.stringify(record), { mode: 0o600 });
		await rename(tmpPath, path);
	} catch {
		try { await unlink(tmpPath); } catch { /* best effort */ }
	}
}

async function fetchPointer(url: string): Promise<string | null> {
	const response = await safeFetch(url, { signal: AbortSignal.timeout(10_000) });
	if (!response.ok) return null;
	const text = (await readBoundedText(response, MAX_POINTER_BYTES)).trim();
	const line = text.split("\n", 1)[0]?.trim() ?? "";
	return VERSION_RE.test(line) ? line : null;
}

let refreshInFlight: Promise<void> | null = null;

function refresh(path: string): Promise<void> {
	if (refreshInFlight) return refreshInFlight;
	refreshInFlight = (async () => {
		for (const url of VERSION_URLS) {
			try {
				const version = await fetchPointer(url);
				if (!version || compareVersions(version, CLIENT_VERSION_FLOOR) <= 0) continue;
				await writeCache(path, { version, fetchedAt: Date.now() });
				return;
			} catch { /* try the fallback pointer */ }
		}
	})().finally(() => { refreshInFlight = null; });
	return refreshInFlight;
}

/**
 * Version to send on a proxy or auth request.
 *
 * The env override wins and skips the lookup. Otherwise the cached version
 * wins when it is newer than the shipped floor. A cache older than a day, or
 * no cache at all, starts one background refresh; this call still returns
 * immediately.
 */
export function resolveClientVersion(): string {
	const override = process.env.PI_XAI_CLIENT_VERSION;
	if (override) return override;
	const path = versionCachePath();
	const cached = readCache(path);
	if (!cached || Date.now() - cached.fetchedAt > CLIENT_VERSION_TTL_MS) {
		void refresh(path);
	}
	return cached?.version ?? CLIENT_VERSION_FLOOR;
}

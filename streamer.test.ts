import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadStreamOpenAIResponses, locatePiAi, streamerTarget, type StreamerImporter } from "./streamer.js";

const stream = vi.fn();

/** An importer that serves `modules` by specifier and throws for the rest, the
 * way a host that only ships some entrypoints behaves. */
function importerFor(modules: Record<string, Record<string, unknown>>): StreamerImporter {
	return async (specifier: string) => {
		const mod = modules[specifier];
		if (!mod) throw new Error(`Cannot find module '${specifier}'`);
		return mod;
	};
}

/** A fake pi-ai install of `version` whose package root resolves to `entryName`,
 * laid out the way the sniff reads it: the manifest one directory above the
 * resolved entry. */
function piAiInstall(version: string, entryName: string): { entry: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "pi-grok-piai-"));
	mkdirSync(join(root, "dist"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
	writeFileSync(join(root, "dist", entryName), "");
	return {
		entry: pathToFileURL(join(root, "dist", entryName)).href,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

describe("locatePiAi", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	it("reads the version from the manifest beside the resolved entry", () => {
		const install = piAiInstall("0.79.10", "index.js");
		cleanups.push(install.cleanup);
		expect(locatePiAi(() => install.entry)).toEqual({ entry: expect.stringMatching(/index\.js$/), version: [0, 79] });
	});

	it("returns undefined when the package cannot be resolved", () => {
		expect(
			locatePiAi(() => {
				throw new Error("ERR_MODULE_NOT_FOUND");
			}),
		).toBeUndefined();
	});

	it("treats a missing version segment as zero", () => {
		const install = piAiInstall("1", "index.js");
		cleanups.push(install.cleanup);
		expect(locatePiAi(() => install.entry)?.version).toEqual([1, 0]);
	});
});

describe("streamerTarget", () => {
	const entry = (name: string) => `/opt/pi/node_modules/@earendil-works/pi-ai/dist/${name}`;

	it("uses the compat entry on pi 1.0, under the legacy name", () => {
		// The compat entry's streamSimple is the dispatching wrapper, so the target
		// names the legacy export and nothing else.
		expect(streamerTarget({ entry: entry("compat.js"), version: [1, 0] })).toEqual({
			specifier: "@earendil-works/pi-ai",
			exportName: "streamSimpleOpenAIResponses",
		});
	});

	it("uses the legacy subpath below pi-ai 0.80", () => {
		expect(streamerTarget({ entry: entry("index.js"), version: [0, 74] })).toEqual({
			specifier: "@earendil-works/pi-ai/openai-responses",
			exportName: "streamSimpleOpenAIResponses",
		});
	});

	it("uses the api subpath from pi-ai 0.80 up", () => {
		expect(streamerTarget({ entry: entry("index.js"), version: [0, 80] })).toEqual({
			specifier: "@earendil-works/pi-ai/api/openai-responses",
			exportName: "streamSimple",
		});
		expect(streamerTarget({ entry: entry("index.js"), version: [0, 99] }).specifier).toBe(
			"@earendil-works/pi-ai/api/openai-responses",
		);
	});
});

describe("loadStreamOpenAIResponses", () => {
	it("imports the legacy subpath for a pi-ai below 0.80", async () => {
		// 0.74 through 0.79 export streamSimpleOpenAIResponses from
		// @earendil-works/pi-ai/openai-responses.
		const install = piAiInstall("0.74.0", "index.js");
		const seen: string[] = [];
		const importModule: StreamerImporter = async (specifier) => {
			seen.push(specifier);
			return { streamSimpleOpenAIResponses: stream };
		};
		await expect(loadStreamOpenAIResponses(importModule, () => install.entry)).resolves.toBe(stream);
		expect(seen).toEqual(["@earendil-works/pi-ai/openai-responses"]);
		install.cleanup();
	});

	it("imports the api subpath for a pi-ai at or above 0.80", async () => {
		const install = piAiInstall("0.99.2", "index.js");
		const seen: string[] = [];
		const importModule: StreamerImporter = async (specifier) => {
			seen.push(specifier);
			return { streamSimple: stream };
		};
		await expect(loadStreamOpenAIResponses(importModule, () => install.entry)).resolves.toBe(stream);
		expect(seen).toEqual(["@earendil-works/pi-ai/api/openai-responses"]);
		install.cleanup();
	});

	it("prefers the legacy name when the version-selected module exports both", async () => {
		const install = piAiInstall("0.79.0", "index.js");
		const wrapper = vi.fn();
		const importModule = importerFor({
			"@earendil-works/pi-ai/openai-responses": {
				streamSimple: wrapper,
				streamSimpleOpenAIResponses: stream,
			},
		});
		await expect(loadStreamOpenAIResponses(importModule, () => install.entry)).resolves.toBe(stream);
		install.cleanup();
	});

	it("takes the compat entry directly on pi 1.0", async () => {
		// pi 1.0 resolves the package root to dist/compat.js and re-exports the
		// legacy name from it. The /api subpath is not in the alias table, so it
		// must not be imported at all.
		const install = piAiInstall("1.0.0", "compat.js");
		const seen: string[] = [];
		const importModule: StreamerImporter = async (specifier) => {
			seen.push(specifier);
			return { streamSimpleOpenAIResponses: stream, streamSimple: vi.fn() };
		};
		await expect(loadStreamOpenAIResponses(importModule, () => install.entry)).resolves.toBe(stream);
		expect(seen).toEqual(["@earendil-works/pi-ai"]);
		install.cleanup();
	});

	it("rejects the dispatching wrapper the compat entry also exports", async () => {
		// compat's streamSimple routes by API instead of being the responses
		// streamer. Accepting it would report the load as fine and stream wrong.
		const install = piAiInstall("1.0.0", "compat.js");
		const importModule = importerFor({
			"@earendil-works/pi-ai": { streamSimple: stream },
		});
		await expect(loadStreamOpenAIResponses(importModule, () => install.entry)).rejects.toThrow(
			/did not export streamSimpleOpenAIResponses/,
		);
		install.cleanup();
	});

	it("fails loudly when the pi-ai package cannot be resolved", async () => {
		const importModule = importerFor({
			"@earendil-works/pi-ai": { streamSimpleOpenAIResponses: stream },
		});
		const resolve = () => {
			throw new Error("ERR_MODULE_NOT_FOUND");
		};
		await expect(loadStreamOpenAIResponses(importModule, resolve)).rejects.toThrow(/could not be resolved/);
	});

	it("ignores a non-function export of the right name", async () => {
		const install = piAiInstall("0.85.0", "index.js");
		const importModule = importerFor({
			"@earendil-works/pi-ai/api/openai-responses": { streamSimple: "not a function" },
		});
		await expect(loadStreamOpenAIResponses(importModule, () => install.entry)).rejects.toThrow(
			/did not export streamSimple/,
		);
		install.cleanup();
	});

	it("names the version and the specifier when nothing resolves", async () => {
		const install = piAiInstall("0.74.0", "index.js");
		const importModule = importerFor({});
		await expect(loadStreamOpenAIResponses(importModule, () => install.entry)).rejects.toThrow(
			/pi-ai 0.74.*streamSimpleOpenAIResponses.*@earendil-works\/pi-ai\/openai-responses/,
		);
		install.cleanup();
	});
});

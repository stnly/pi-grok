import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadStreamOpenAIResponses, locatePiAi, streamerTarget, type SpecifierResolver, type StreamerImporter } from "./streamer.js";

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

	it("treats a Windows compat path as the pi 1.0 entry", () => {
		// fileURLToPath uses backslashes on Windows, so a forward-slash suffix
		// would miss the compat entry and import a subpath the alias table lacks.
		const entry = win32.join("C:\\pi", "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js");
		expect(streamerTarget({ entry, version: [1, 2] })).toEqual({
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

	it("falls back to the package root when the subpath cannot resolve", async () => {
		// Hosts before pi 1.0 alias only the package root, so a bare install on
		// pi 0.74 cannot resolve the legacy subpath even though the export
		// exists in the package. The probe moves the target to the root, which
		// pi-ai re-exports the legacy streamer name from, and only that import
		// is attempted.
		const install = piAiInstall("0.74.0", "index.js");
		const seen: string[] = [];
		const resolve: SpecifierResolver = (specifier) => {
			if (specifier === "@earendil-works/pi-ai/openai-responses") {
				throw new Error(`Cannot find module '${specifier}'`);
			}
			return install.entry;
		};
		const importModule: StreamerImporter = async (specifier) => {
			seen.push(specifier);
			return { streamSimpleOpenAIResponses: stream };
		};
		await expect(loadStreamOpenAIResponses(importModule, resolve)).resolves.toBe(stream);
		expect(seen).toEqual(["@earendil-works/pi-ai"]);
		install.cleanup();
	});

	it("falls back under the legacy name when the api subpath cannot resolve", async () => {
		// The >=0.80 target wants streamSimple, but the root that answers the
		// fallback carries the legacy name. Accepting streamSimple from a root
		// would run the API-dispatching wrapper instead of this streamer.
		const install = piAiInstall("0.85.0", "index.js");
		const resolve: SpecifierResolver = (specifier) => {
			if (specifier === "@earendil-works/pi-ai/api/openai-responses") {
				throw new Error(`Cannot find module '${specifier}'`);
			}
			return install.entry;
		};
		const importModule = importerFor({
			"@earendil-works/pi-ai": { streamSimpleOpenAIResponses: stream, streamSimple: vi.fn() },
		});
		await expect(loadStreamOpenAIResponses(importModule, resolve)).resolves.toBe(stream);
		install.cleanup();
	});

	it("does not probe the root for a target that already uses it", async () => {
		// The compat entry target is the package root. Probing it for
		// reachability would ask the same question the import answers, and a
		// resolution failure there must surface, not trigger a self-fallback.
		const install = piAiInstall("1.0.0", "compat.js");
		const probed: string[] = [];
		const resolve: SpecifierResolver = (specifier) => {
			probed.push(specifier);
			return install.entry;
		};
		const importModule: StreamerImporter = async () => {
			throw new Error("Cannot find module");
		};
		await expect(loadStreamOpenAIResponses(importModule, resolve)).rejects.toThrow(/did not export/);
		expect(probed).toEqual(["@earendil-works/pi-ai"]);
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

	it("loads from the virtual root of a bundled host when nothing resolves", async () => {
		// The npm `pi` bin embeds pi-ai as a virtual module: import.meta.resolve
		// throws, so no entry or manifest can be read, but the root import
		// carries the compat surface with the legacy streamer name.
		const seen: string[] = [];
		const resolve: SpecifierResolver = () => {
			throw new Error("Cannot find module '@earendil-works/pi-ai'");
		};
		const importModule: StreamerImporter = async (specifier) => {
			seen.push(specifier);
			return { streamSimpleOpenAIResponses: stream };
		};
		await expect(loadStreamOpenAIResponses(importModule, resolve)).resolves.toBe(stream);
		expect(seen).toEqual(["@earendil-works/pi-ai"]);
	});

	it("rejects when nothing resolves and the root import fails too", async () => {
		const resolve: SpecifierResolver = () => {
			throw new Error("Cannot find module '@earendil-works/pi-ai'");
		};
		const importModule = importerFor({});
		await expect(loadStreamOpenAIResponses(importModule, resolve)).rejects.toThrow(/could not be resolved/);
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

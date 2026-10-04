import { describe, expect, it, vi } from "vitest";
import {
	STREAMER_SPECIFIERS,
	loadStreamOpenAIResponses,
	type StreamerImporter,
} from "./streamer.js";

const stream = vi.fn();

/** An importer that serves `modules` by specifier and throws for everything
 * else, the way a host that only aliases some specifiers behaves. */
function importerFor(modules: Record<string, Record<string, unknown>>): StreamerImporter {
	return async (specifier: string) => {
		const mod = modules[specifier];
		if (!mod) throw new Error(`Cannot find module '${specifier}'`);
		return mod;
	};
}

describe("loadStreamOpenAIResponses", () => {
	it("finds the streamer on the host-provided specifier", async () => {
		// pi 1.0.x maps the bare package to its compat entry, which re-exports
		// the legacy name; the /api subpath is not in the alias table at all.
		const importModule = importerFor({
			"@earendil-works/pi-ai": { streamSimpleOpenAIResponses: stream },
		});
		await expect(loadStreamOpenAIResponses(importModule)).resolves.toBe(stream);
	});

	it("accepts the modern export name on a newer entrypoint", async () => {
		const importModule = importerFor({
			"@earendil-works/pi-ai": {},
			"@earendil-works/pi-ai/api/openai-responses": { streamSimple: stream },
		});
		await expect(loadStreamOpenAIResponses(importModule)).resolves.toBe(stream);
	});

	it("prefers the unambiguous legacy name when a module exposes both", async () => {
		const generic = vi.fn();
		const importModule = importerFor({
			"@earendil-works/pi-ai": {
				streamSimple: generic,
				streamSimpleOpenAIResponses: stream,
			},
		});
		await expect(loadStreamOpenAIResponses(importModule)).resolves.toBe(stream);
	});

	it("keeps probing when a specifier cannot be resolved", async () => {
		// The failure this guards: the host refuses the first specifier, and
		// throwing instead of continuing takes the whole extension down.
		const importModule = importerFor({
			"@earendil-works/pi-ai/api/openai-responses": { streamSimple: stream },
		});
		await expect(loadStreamOpenAIResponses(importModule)).resolves.toBe(stream);
	});

	it("keeps probing when a specifier resolves without a streamer", async () => {
		// A resolved module with neither export must not hand back undefined:
		// that defers the failure to the first request instead of using a
		// layout that works.
		const importModule = importerFor({
			"@earendil-works/pi-ai": { somethingElse: true },
			"@earendil-works/pi-ai/api/openai-responses": { streamSimple: stream },
		});
		await expect(loadStreamOpenAIResponses(importModule)).resolves.toBe(stream);
	});

	it("ignores a non-function export of the right name", async () => {
		const importModule = importerFor({
			"@earendil-works/pi-ai": { streamSimple: "not a function" },
			"@earendil-works/pi-ai/openai-responses": { streamSimpleOpenAIResponses: stream },
		});
		await expect(loadStreamOpenAIResponses(importModule)).resolves.toBe(stream);
	});

	it("reports every specifier it tried when the host has none", async () => {
		const importModule = importerFor({});
		await expect(loadStreamOpenAIResponses(importModule)).rejects.toThrow(
			/Tried: @earendil-works\/pi-ai, @earendil-works\/pi-ai\/api\/openai-responses, @earendil-works\/pi-ai\/openai-responses/,
		);
	});

	it("probes the host-provided specifier first", async () => {
		const seen: string[] = [];
		const importModule: StreamerImporter = async (specifier) => {
			seen.push(specifier);
			return { streamSimple: stream };
		};
		await loadStreamOpenAIResponses(importModule);
		// The bare package is the entry the loader aliases, so it resolves
		// without a physical pi-ai on disk; the subpaths are fallbacks.
		expect(seen).toEqual(["@earendil-works/pi-ai"]);
		expect(STREAMER_SPECIFIERS[0]).toBe("@earendil-works/pi-ai");
	});
});

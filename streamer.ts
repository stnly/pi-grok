/**
 * Locate the OpenAI responses streamer on the running host.
 *
 * pi-ai moved this export twice, and the peer range starts at 0.74.0, so every
 * one of these layouts has to resolve:
 *
 * - pi-ai <=0.79 exports `streamSimpleOpenAIResponses` from
 *   `@earendil-works/pi-ai/openai-responses`.
 * - pi-ai >=0.80 exports `streamSimple` from
 *   `@earendil-works/pi-ai/api/openai-responses`. Its package root exports a
 *   `streamSimple` too, but that one dispatches across APIs instead of being
 *   this streamer.
 * - pi 1.0 aliases `@earendil-works/pi-ai` to the compat entry, which
 *   re-exports the legacy `streamSimpleOpenAIResponses`. The `/api` subpath is
 *   not in that alias table, so the >=0.80 import cannot resolve there.
 *
 * Which of the three a host is shows up in where the package root resolves.
 * pi-ai's own package resolves it to `dist/index.js`. pi 1.0's loader resolves
 * it to `dist/compat.js`. The compat entry is the pi 1.0 path and it is taken
 * directly, so the load never depends on an import failing first.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export type StreamOpenAIResponses = (
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** The two names the streamer has been exported under. */
export interface StreamerModule {
	streamSimpleOpenAIResponses?: unknown;
	streamSimple?: unknown;
}

/** Injectable so the lookup can be tested without a host to import from. */
export type StreamerImporter = (specifier: string) => Promise<StreamerModule>;

const importModule: StreamerImporter = (specifier) => import(specifier);

/** The package root. pi 1.0's loader aliases this to the compat entry. */
const ROOT_SPECIFIER = "@earendil-works/pi-ai";

/** Where the responses streamer lives on one host layout, and the name it is exported under. */
export interface StreamerTarget {
	specifier: string;
	exportName: keyof StreamerModule;
}

export interface PiAiLocation {
	/** Where the package root resolved, as a filesystem path. */
	entry: string;
	version: [number, number];
}

/**
 * Resolve the installed pi-ai and read its version.
 *
 * `package.json` is not an exported subpath, so the manifest is read off disk
 * from beside the resolved entry. Returns `undefined` when the package cannot
 * be resolved.
 */
export function locatePiAi(resolve: (specifier: string) => string = (specifier) =>
	import.meta.resolve(specifier),
): PiAiLocation | undefined {
	let entry: string;
	try {
		entry = fileURLToPath(resolve(ROOT_SPECIFIER));
	} catch {
		return undefined;
	}
	const { version } = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as {
		version: string;
	};
	const [major = 0, minor = 0] = version.split(".").map(Number);
	return { entry, version: [major, minor] };
}

/**
 * The specifier and export name that carry the responses streamer for an
 * installed pi-ai.
 *
 * pi 1.0's loader aliases the package root to `dist/compat.js`, which
 * re-exports the legacy name, while pi-ai's own package resolves the root to
 * `dist/index.js`. The entry filename is what separates that host from the
 * version split: `./openai-responses` below 0.80, `./api/openai-responses` from
 * 0.80 up. Each layout names exactly one export, because the other name is the
 * API-dispatching wrapper on the compat entry and on the >=0.80 package root.
 */
export function streamerTarget(located: PiAiLocation): StreamerTarget {
	if (located.entry.endsWith("/compat.js")) {
		return { specifier: ROOT_SPECIFIER, exportName: "streamSimpleOpenAIResponses" };
	}
	const [major, minor] = located.version;
	return major > 0 || minor >= 80
		? { specifier: "@earendil-works/pi-ai/api/openai-responses", exportName: "streamSimple" }
		: { specifier: "@earendil-works/pi-ai/openai-responses", exportName: "streamSimpleOpenAIResponses" };
}

/**
 * Resolve the host's OpenAI responses streamer.
 */
export async function loadStreamOpenAIResponses(
	importModuleFn: StreamerImporter = importModule,
	resolve?: (specifier: string) => string,
): Promise<StreamOpenAIResponses> {
	const located = locatePiAi(resolve);
	if (!located) {
		throw new Error("pi-grok: the installed pi-ai could not be resolved.");
	}
	const target = streamerTarget(located);
	const missing = () =>
		new Error(
			`pi-grok: pi-ai ${located.version.join(".")} did not export ${target.exportName} from ${target.specifier}.`,
		);
	let mod: StreamerModule;
	try {
		mod = await importModuleFn(target.specifier);
	} catch {
		throw missing();
	}
	const stream = mod[target.exportName];
	if (typeof stream !== "function") throw missing();
	return stream as StreamOpenAIResponses;
}

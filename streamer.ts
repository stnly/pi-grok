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
 *
 * Hosts before pi 1.0 alias only the package root, not the subpaths, so in an
 * installed layout (no node_modules beside the source) the version-selected
 * subpath specifier cannot resolve even though the export exists in the
 * package. Reachability is asked of the host before importing: when the
 * canonical subpath does not resolve, the package root is aliased on every
 * host generation and pi-ai re-exports the legacy streamer name from it below
 * 0.80, so the target moves to the root. Resolution never evaluates a module,
 * so the probe cannot mistake a broken module for an unreachable one.
 *
 * A bundled host (the npm `pi` bin) embeds pi-ai as a virtual module. The root
 * import reaches the compat surface and carries the legacy streamer name, but
 * no filesystem entry or manifest exists, so resolution and the version sniff
 * cannot run at all. An unresolvable package therefore falls through to a root
 * import before giving up.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/** Injectable so the reachability probe can be tested without a host. */
export type SpecifierResolver = (specifier: string) => string;

/** Resolve parented on this file. On Windows the parent has to be a file URL
 * or the node_modules walk from a drive-letter path fails; see locatePiAi. */
const defaultResolve: SpecifierResolver = (specifier) =>
	import.meta.resolve(specifier, pathToFileURL(import.meta.filename).href);

/** The package root. pi 1.0's loader aliases this to the compat entry. */
const ROOT_SPECIFIER = "@earendil-works/pi-ai";

/** Whether the host can resolve `specifier` from extension code. Resolution
 * never evaluates the module, so a throw means unreachable, not broken. */
function resolvable(resolve: SpecifierResolver, specifier: string): boolean {
	try {
		resolve(specifier);
		return true;
	} catch {
		return false;
	}
}

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
export function locatePiAi(resolve: SpecifierResolver = defaultResolve): PiAiLocation | undefined {
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
	// fileURLToPath yields backslashes on Windows. Match the filename
	// against either separator so the check holds on every platform, including
	// when a test feeds a Windows path to a POSIX host.
	if (/(^|[\/\\])compat\.js$/.test(located.entry)) {
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
	resolve: SpecifierResolver = defaultResolve,
): Promise<StreamOpenAIResponses> {
	const located = locatePiAi(resolve);
	if (!located) {
		// No entry, no manifest: a bundled host embeds pi-ai as a virtual module
		// whose root import is the compat surface. Import it and take the legacy
		// name directly; when that import fails too, pi-ai is genuinely absent.
		const mod = await importModuleFn(ROOT_SPECIFIER).then(
			(root) => root,
			() => undefined,
		);
		const stream = mod?.streamSimpleOpenAIResponses;
		if (typeof stream === "function") return stream as StreamOpenAIResponses;
		throw new Error("pi-grok: the installed pi-ai could not be resolved.");
	}
	let target = streamerTarget(located);
	// A subpath the host's loader cannot alias is unreachable in an installed
	// layout. The package root is aliased on every host generation, so move
	// the target there under the legacy name pi-ai re-exports below 0.80.
	if (target.specifier !== ROOT_SPECIFIER && !resolvable(resolve, target.specifier)) {
		target = { specifier: ROOT_SPECIFIER, exportName: "streamSimpleOpenAIResponses" };
	}
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

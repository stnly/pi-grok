/**
 * Locate the OpenAI responses streamer on the running host.
 *
 * pi-ai moved this export between entrypoints:
 *
 * - pi-ai <=0.79 exports `streamSimpleOpenAIResponses` from the package root.
 * - pi-ai >=0.80 exports `streamSimple` from
 *   `@earendil-works/pi-ai/api/openai-responses`.
 *
 * Pi's extension loader hands extensions a fixed alias table instead of letting
 * them resolve host packages off disk. On pi 1.0.x that table maps
 * `@earendil-works/pi-ai` (to the compat entry, which re-exports the legacy
 * `streamSimpleOpenAIResponses`), `/compat`, `/oauth`, and `/providers/all` —
 * but *not* `/api/openai-responses`. Naming that subpath statically therefore
 * fails to resolve inside the extension, and because the import is what
 * supplies the provider's stream function, the entire extension refuses to
 * load: `Cannot find module '@earendil-works/pi-ai'`, with every xai-oauth
 * model then reported as unmatched.
 *
 * Sniffing the installed pi-ai version to pick a specifier cannot see the alias
 * table, so it cannot know which layouts the host will actually hand over.
 * Probe instead: try the host-provided specifier and each known subpath in
 * turn, and accept the first module that really exposes a streamer. The shape
 * check matters — a specifier can resolve to a module that has neither name,
 * and returning `undefined` there would defer the failure to the first request
 * instead of falling through to a layout that works.
 */

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

/**
 * Specifiers to try, in order.
 *
 * The bare package first: it is the host-provided entry the extension loader
 * aliases for us, so it resolves without a physical copy of pi-ai on disk and
 * cannot pick up a duplicate module. The subpaths cover hosts that expose the
 * newer entrypoint and hosts pinned to pi-ai <=0.79.
 */
export const STREAMER_SPECIFIERS = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/api/openai-responses",
	"@earendil-works/pi-ai/openai-responses",
] as const;

/** The two names the streamer has been exported under. */
interface StreamerModule {
	streamSimpleOpenAIResponses?: unknown;
	streamSimple?: unknown;
}

/** Injectable so the probe can be tested without a host to import from. */
export type StreamerImporter = (specifier: string) => Promise<StreamerModule>;

const importModule: StreamerImporter = (specifier) => import(specifier);

/**
 * Resolve the host's OpenAI responses streamer.
 *
 * Prefers the unambiguous legacy name when a module exposes both: the generic
 * `streamSimple` is an api-dispatching wrapper, while `streamSimpleOpenAIResponses`
 * *is* this streamer.
 */
export async function loadStreamOpenAIResponses(
	importModuleFn: StreamerImporter = importModule,
): Promise<StreamOpenAIResponses> {
	const tried: string[] = [];
	for (const specifier of STREAMER_SPECIFIERS) {
		tried.push(specifier);
		let mod: StreamerModule;
		try {
			mod = await importModuleFn(specifier);
		} catch {
			// Not resolvable on this host (missing entrypoint, or the loader's
			// alias table has no entry for it). Try the next layout.
			continue;
		}
		const stream = mod.streamSimpleOpenAIResponses ?? mod.streamSimple;
		if (typeof stream === "function") {
			return stream as StreamOpenAIResponses;
		}
	}
	throw new Error(
		`pi-grok: the host exposes no OpenAI responses streamer. Tried: ${tried.join(", ")}`,
	);
}

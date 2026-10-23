import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

/**
 * Load the extension end to end through the host's own loader.
 *
 * The rest of the suite imports the source directly. This copies it to a
 * directory with no node_modules, the layout a `pi install` produces, and
 * loads that copy through pi's extension loader.
 */
describe("extension load without a local pi-ai", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-grok-load-"));
	// The loader is not an exported subpath. The package entry resolves to
	// dist/index.js, so the package root sits two directories above it.
	// PI_GROK_LOAD_TEST_PI points the test at a specific pi install.
	const installed = process.env.PI_GROK_LOAD_TEST_PI
		?? dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
	const { loadExtensions } = createRequire(import.meta.url)(join(installed, "dist/core/extensions/loader.js")) as {
		loadExtensions: (paths: string[], cwd: string) => Promise<LoadExtensionsResult>;
	};

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// Loading through the host loader compiles the whole extension and imports
	// the host's loader graph. On a slow disk that alone can exceed the 5s
	// vitest default, so allow plenty of headroom.
	it("loads through the host loader when no pi-ai sits beside the source", { timeout: 120_000 }, async () => {
		cpSync(new URL(".", import.meta.url), dir, {
			recursive: true,
			filter: (path) => !path.includes("node_modules"),
		});
		const { extensions, errors } = await loadExtensions([join(dir, "index.ts")], dir);
		expect(errors).toEqual([]);
		expect(extensions).toHaveLength(1);
	});
});

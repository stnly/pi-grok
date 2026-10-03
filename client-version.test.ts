import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => process.env.PI_GROK_TEST_AGENT_DIR ?? "",
}));

import { CLIENT_VERSION_FLOOR, compareVersions, resetClientVersionForTests, resolveClientVersion } from "./client-version.js";

describe("compareVersions", () => {
	it("orders by major, then minor, then patch", () => {
		expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
		expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
		expect(compareVersions("1.0.46", "1.0.46")).toBe(0);
	});

	it("treats a suffix as newer than the bare release", () => {
		expect(compareVersions("1.0.47-alpha", "1.0.47")).toBeGreaterThan(0);
		expect(compareVersions("1.0.47", "1.0.47-alpha")).toBeLessThan(0);
	});
});

describe("resolveClientVersion", () => {
	let tmpDir: string;
	const originalFetch = globalThis.fetch;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "pi-grok-version-"));
		process.env.PI_GROK_TEST_AGENT_DIR = tmpDir;
		delete process.env.PI_XAI_CLIENT_VERSION;
		resetClientVersionForTests();
		globalThis.fetch = vi.fn(async () => new Response("not called", { status: 500 })) as typeof fetch;
	});

	afterEach(async () => {
		delete process.env.PI_GROK_TEST_AGENT_DIR;
		delete process.env.PI_XAI_CLIENT_VERSION;
		globalThis.fetch = originalFetch;
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("returns the env override and does not fetch", () => {
		process.env.PI_XAI_CLIENT_VERSION = "9.9.9";
		expect(resolveClientVersion()).toBe("9.9.9");
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("returns the shipped floor when the cache is empty", () => {
		expect(resolveClientVersion()).toBe(CLIENT_VERSION_FLOOR);
	});

	it("returns a cached version newer than the floor", async () => {
		const dir = join(tmpDir, "cache", "pi-grok");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "version.json"), JSON.stringify({
			version: "1.2.3",
			fetchedAt: Date.now(),
		}));
		expect(resolveClientVersion()).toBe("1.2.3");
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("ignores a cached version at or below the floor", async () => {
		const dir = join(tmpDir, "cache", "pi-grok");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "version.json"), JSON.stringify({
			version: "1.0.13",
			fetchedAt: Date.now(),
		}));
		expect(resolveClientVersion()).toBe(CLIENT_VERSION_FLOOR);
	});

	it("writes a fetched version newer than the floor", async () => {
		globalThis.fetch = vi.fn(async () => new Response("1.4.0\n")) as typeof fetch;
		expect(resolveClientVersion()).toBe(CLIENT_VERSION_FLOOR);
		await vi.waitFor(async () => {
			const text = await readFile(join(tmpDir, "cache", "pi-grok", "version.json"), "utf8");
			expect(JSON.parse(text).version).toBe("1.4.0");
		});
	});

	it("does not cache a fetched version at or below the floor", async () => {
		globalThis.fetch = vi.fn(async () => new Response("1.0.46")) as typeof fetch;
		resolveClientVersion();
		await new Promise((r) => setTimeout(r, 50));
		await expect(readFile(join(tmpDir, "cache", "pi-grok", "version.json"), "utf8")).rejects.toThrow();
	});

	it("does not refetch on every call while the pointer is down", async () => {
		const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
		globalThis.fetch = fetchMock as typeof fetch;
		resolveClientVersion();
		// One attempt tries both pointers, so wait until both have been called.
		await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
		resolveClientVersion();
		resolveClientVersion();
		await new Promise((r) => setTimeout(r, 50));
		expect(fetchMock.mock.calls.length).toBe(2);
	});

	it("rejects a pointer body that is not a version", async () => {
		globalThis.fetch = vi.fn(async () => new Response("<html>nope</html>")) as typeof fetch;
		resolveClientVersion();
		await new Promise((r) => setTimeout(r, 50));
		await expect(readFile(join(tmpDir, "cache", "pi-grok", "version.json"), "utf8")).rejects.toThrow();
	});
});

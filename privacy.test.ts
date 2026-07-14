import { describe, expect, it } from "vitest";
import { getKeybindings } from "@earendil-works/pi-tui";
import { runPrivacyPicker, type CustomUi } from "./privacy.js";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Identity theme stub. The picker's render output isn't asserted here; we only
 * exercise its input handling, so styling passes through unchanged. DynamicBorder
 * reads the real `theme` proxy only at render time, which these tests never do.
 */
const stubTheme = {
	fg: (_c: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

interface CapturingUi extends CustomUi {
	component: Component & { handleInput(d: string): void };
}

/**
 * Build a fake `ctx.ui` whose `custom()` captures the created component and
 * wires its `done` callback straight to the returned promise. The factory runs
 * synchronously, so `ui.component` is populated the instant the picker starts.
 */
function makeCapturingUi(): CapturingUi {
	let component: (Component & { handleInput(d: string): void }) | undefined;
	const ui: CapturingUi = {
		custom: (factory) =>
			new Promise((resolve) => {
				const made = factory(
					undefined,
					stubTheme,
					// Real keybindings so handleInput matches enter/up/down/escape
					// the same way the live TUI routes them.
					getKeybindings(),
					(result) => resolve(result),
				);
				if (made instanceof Promise) throw new Error("async factory not supported by this stub");
				component = made as Component & { handleInput(d: string): void };
			}),
		get component() {
			return component!;
		},
	};
	return ui;
}

describe("runPrivacyPicker", () => {
	it("confirms the current mode when enter is pressed without moving", async () => {
		const ui = makeCapturingUi();
		const p = runPrivacyPicker(ui, true); // current = privacy (optOut=true)
		ui.component.handleInput("\r"); // enter
		await expect(p).resolves.toBe(true);
	});

	it("moves down then confirms the other mode", async () => {
		const ui = makeCapturingUi();
		const p = runPrivacyPicker(ui, true); // current = privacy (index 0)
		ui.component.handleInput("\x1b[B"); // down
		ui.component.handleInput("\r"); // enter -> share data (optOut=false)
		await expect(p).resolves.toBe(false);
	});

	it("moves up from share data to privacy", async () => {
		const ui = makeCapturingUi();
		const p = runPrivacyPicker(ui, false); // current = share data (index 1)
		ui.component.handleInput("\x1b[A"); // up -> index 0
		ui.component.handleInput("\r"); // enter -> privacy (optOut=true)
		await expect(p).resolves.toBe(true);
	});

	it("clamps at the top boundary", async () => {
		const ui = makeCapturingUi();
		const p = runPrivacyPicker(ui, false); // current = share data (index 1)
		ui.component.handleInput("\x1b[A"); // up -> index 0
		ui.component.handleInput("\x1b[A"); // up -> clamped at 0
		ui.component.handleInput("\r"); // enter -> privacy (optOut=true)
		await expect(p).resolves.toBe(true);
	});

	it("resolves undefined on cancel (escape)", async () => {
		const ui = makeCapturingUi();
		const p = runPrivacyPicker(ui, true);
		ui.component.handleInput("\x1b"); // escape
		await expect(p).resolves.toBeUndefined();
	});
});

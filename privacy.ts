/**
 * Interactive privacy picker rendered through `ctx.ui.custom`.
 *
 * `ctx.ui.select` only takes flat strings, so it can't reproduce the login
 * flow's themed green tick on the configured row. `ctx.ui.custom` hands us a
 * real component slot plus the active `Theme`, so we mirror the OAuth login
 * selector: two rows, a `→ ` focus cursor on the highlighted one, and a green
 * `✓ current` marker on the row matching the account state.
 *
 * Shown with `overlay: false` so the component renders inline, replacing the
 * prompt area the way `ctx.ui.select` does, rather than as a floating popup.
 * Theme-aware, so the tick reads correctly on light and dark themes.
 */

import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Spacer,
	Text,
	TruncatedText,
} from "@earendil-works/pi-tui";
import { DynamicBorder, keyText } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { privacyChoices, type PrivacyChoice } from "./account.js";

/** Minimal slice of ExtensionUIContext we need: the custom-component slot. */
export interface CustomUi {
	custom<T>(
		factory: (
			tui: unknown,
			theme: Theme,
			keybindings: ReturnType<typeof getKeybindings>,
			done: (result: T) => void,
		) => Component | Promise<Component>,
		options?: { overlay?: boolean },
	): Promise<T>;
}

/**
 * Two privacy rows plus the index of the account's current state.
 *
 * Kept as plain data so the render path has no work to do at interaction time
 * except move the focus cursor.
 */
interface PickerModel {
	choices: PrivacyChoice[];
	currentIndex: number;
}

function buildModel(currentOptOut: boolean): PickerModel {
	const choices = privacyChoices(currentOptOut);
	const currentIndex = choices.findIndex((c) => c.optOut === currentOptOut);
	return { choices, currentIndex: currentIndex < 0 ? 0 : currentIndex };
}

/**
 * Component shown while the user picks. Mirrors OAuthSelectorComponent: a
 * bordered list with a focus cursor and a themed status marker on the current
 * row. Resolves `done(optOut | undefined)` on confirm or cancel.
 */
class PrivacyPickerComponent extends Container implements Focusable {
	private readonly model: PickerModel;
	private readonly theme: Theme;
	private readonly done: (result: boolean | undefined) => void;
	private readonly list: Container;
	private selectedIndex: number;
	private _focused = false;

	constructor(theme: Theme, model: PickerModel, done: (result: boolean | undefined) => void) {
		super();
		this.theme = theme;
		this.model = model;
		this.done = done;
		this.selectedIndex = model.currentIndex;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(this.theme.fg("accent", this.theme.bold("Coding data privacy")), 1, 0));
		this.addChild(new Spacer(1));
		this.list = new Container();
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		// Keybinding hint line, identical to the extension/login selectors:
		// arrows to navigate, resolved enter to select, resolved escape/ctrl+c
		// to cancel. Built from the injected theme (not the global theme proxy)
		// so it renders under test with a stub theme.
		this.addChild(new Text(this.renderHint(), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.renderList();
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	/**
	 * The navigate/select/cancel hint line, themed like the login selector.
	 *
	 * Mirrors `rawKeyHint("↑↓", "navigate") + keyHint(confirm, "select") +
	 * keyHint(cancel, "cancel")` but built from the injected theme instance so
	 * it does not depend on the global theme proxy being initialized.
	 */
	private renderHint(): string {
		const hint = (key: string, desc: string) => this.theme.fg("dim", key) + this.theme.fg("muted", ` ${desc}`);
		return [
			hint("↑↓", "navigate"),
			hint(keyText("tui.select.confirm"), "select"),
			hint(keyText("tui.select.cancel"), "cancel"),
		].join("  ");
	}

	private renderList(): void {
		this.list.clear();
		for (let i = 0; i < this.model.choices.length; i++) {
			const choice = this.model.choices[i]!;
			const focused = i === this.selectedIndex;
			const cursor = focused ? this.theme.fg("accent", "→ ") : "  ";
			// Green tick on the row that matches the account's current state,
			// matching the login selector's `✓ configured` affordance.
			const status = choice.current
				? this.theme.fg("success", " ✓ current")
				: this.theme.fg("muted", " • ");
			this.list.addChild(new TruncatedText(`${cursor}${this.theme.fg("text", choice.label)}${status}`, 1, 0));
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.renderList();
		} else if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(this.model.choices.length - 1, this.selectedIndex + 1);
			this.renderList();
		} else if (kb.matches(data, "tui.select.confirm")) {
			const picked = this.model.choices[this.selectedIndex];
			this.done(picked?.optOut);
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.done(undefined);
		}
	}
}

/**
 * Show the picker inline and resolve to the chosen opt-out value.
 *
 * `overlay: false` renders the component in the prompt area (like
 * `ctx.ui.select`) instead of as a floating popup. `undefined` means the user
 * cancelled (Escape / Ctrl+C), so the caller can no-op. Exported for testing
 * via dependency injection of `ui`.
 */
export async function runPrivacyPicker(ui: CustomUi, currentOptOut: boolean): Promise<boolean | undefined> {
	const model = buildModel(currentOptOut);
	return ui.custom<boolean | undefined>(
		(_tui, theme, _kb, done) => new PrivacyPickerComponent(theme, model, done),
		{ overlay: false },
	);
}

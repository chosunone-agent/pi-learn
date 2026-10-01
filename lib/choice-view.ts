/**
 * The shared pop-up choice component behind `teach_ask` and `teach_quiz`.
 *
 * Both tools are the same interaction with different furniture: a list of
 * authored options you move through, optional rows appended by the runtime
 * (write your own answer, "I don't know", add a note), and a submit step when
 * more than one answer is allowed.
 *
 * Two invariants this file exists to enforce:
 *
 * 1. Every rendered line fits the width it was rendered for. `render()` is
 *    re-entered with a new width on terminal resize, and pi does not call
 *    `invalidate()` first, so the line cache MUST be keyed on width. Returning
 *    stale, wider lines trips pi's width guard and crashes the process.
 * 2. One pop-up at a time. Callers serialize through `withUiLock()`.
 */

import { Editor, type EditorTheme, Key, type KeybindingsManager, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** A model-authored answer option. */
export interface ChoiceOption {
	label: string;
	value: string;
	description?: string;
}

/** An extra, runtime-appended row that resolves to an exclusive outcome. */
export interface ExtraRow {
	id: string;
	label: string;
	hint?: string;
}

export interface ChoiceRequest {
	title: string;
	context?: string;
	options: ChoiceOption[];
	multiSelect: boolean;
	/** When set, append a row that opens an inline editor for a custom answer. */
	customAnswerLabel?: string;
	/** Rows such as "I don't know" that are mutually exclusive with real options. */
	extraRows?: ExtraRow[];
	/** When true, `n` (and a list row) opens a note editor. */
	noteEnabled?: boolean;
}

export interface ChoiceResult {
	/** Chosen options, in display order. Empty when the user only typed/declined. */
	selections: ChoiceOption[];
	/** Free text from the custom-answer row, when the user wrote one. */
	customText?: string;
	/** Which extra row the user chose, when any. */
	extraId?: string;
	/** Note text, when the user wrote one. */
	note?: string;
}

type Row =
	| { kind: "option"; option: ChoiceOption; displayIndex: number }
	| { kind: "custom" }
	| { kind: "extra"; extra: ExtraRow }
	| { kind: "note" }
	| { kind: "submit" };

function createEditorTheme(theme: EditorThemeContext): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

/**
 * Minimal structural view of pi's theme. Declared locally rather than imported
 * so this module typechecks without pulling in the full coding-agent types, and
 * so a theme change in pi does not break compilation of the component.
 */
export interface EditorThemeContext {
	fg(token: string, text: string): string;
}

interface RenderContext {
	tui: { requestRender(): void };
	theme: EditorThemeContext & { style?: unknown };
	keybindings: KeybindingsManager;
	done(result: ChoiceResult | null): void;
}

function pushWrapped(lines: string[], text: string, width: number, indent = ""): void {
	const contentWidth = Math.max(1, width - indent.length);
	for (const line of wrapTextWithAnsi(text, contentWidth)) {
		lines.push(truncateToWidth(`${indent}${line}`, width));
	}
}

function buildRows(request: ChoiceRequest): Row[] {
	const rows: Row[] = request.options.map((option, index) => ({
		kind: "option" as const,
		option,
		displayIndex: index + 1,
	}));
	if (request.customAnswerLabel) rows.push({ kind: "custom" });
	for (const extra of request.extraRows ?? []) rows.push({ kind: "extra", extra });
	if (request.noteEnabled) rows.push({ kind: "note" });
	if (request.multiSelect) rows.push({ kind: "submit" });
	return rows;
}

/**
 * Open the choice pop-up and resolve to the user's answer, or `null` when the
 * user cancelled. The caller owns the UI lock.
 */
export function openChoice(ctx: {
	hasUI: boolean;
	ui: { custom<T>(factory: (tui: unknown, theme: unknown, keybindings: KeybindingsManager, done: (result: T) => void) => unknown): Promise<T> };
}, request: ChoiceRequest): Promise<ChoiceResult | null> {
	return ctx.ui.custom<ChoiceResult | null>((tuiRaw, themeRaw, keybindings, done) => {
		const context: RenderContext = {
			tui: tuiRaw as RenderContext["tui"],
			theme: themeRaw as RenderContext["theme"],
			keybindings,
			done,
		};
		return new ChoiceComponent(context, request);
	});
}

class ChoiceComponent {
	private readonly context: RenderContext;
	private readonly request: ChoiceRequest;
	private readonly rows: Row[];
	private readonly editor: Editor;
	private readonly noteEditor: Editor;

	private cursor = 0;
	private editMode: "none" | "custom" | "note" = "none";
	private customText: string | undefined;
	private note: string | undefined;
	private extraId: string | undefined;
	private readonly selected = new Map<string, ChoiceOption>();

	private cachedLines: string[] | undefined;
	private cachedWidth = -1;

	constructor(context: RenderContext, request: ChoiceRequest) {
		this.context = context;
		this.request = request;
		this.rows = buildRows(request);
		this.editor = new Editor(context.tui as never, createEditorTheme(context.theme));
		this.noteEditor = new Editor(context.tui as never, createEditorTheme(context.theme));
		this.editor.onSubmit = (value) => this.commitCustom(value);
		this.noteEditor.onSubmit = (value) => this.commitNote(value);
	}

	// ── state transitions ────────────────────────────────────────────────────

	private refresh(): void {
		this.cachedLines = undefined;
		this.context.tui.requestRender();
	}

	private commitCustom(value: string): void {
		const trimmed = value.trim();
		if (!trimmed) return;
		this.customText = trimmed;
		this.editMode = "none";
		if (!this.request.multiSelect) {
			this.context.done({ selections: [], customText: trimmed, note: this.note });
			return;
		}
		this.refresh();
	}

	private commitNote(value: string): void {
		const trimmed = value.trim();
		this.note = trimmed.length > 0 ? trimmed : undefined;
		this.editMode = "none";
		this.refresh();
	}

	private toggle(option: ChoiceOption): void {
		if (this.selected.has(option.value)) this.selected.delete(option.value);
		else this.selected.set(option.value, option);
		// Choosing a real answer contradicts "I don't know"; drop the extra.
		this.extraId = undefined;
		this.refresh();
	}

	private chooseExtra(extra: ExtraRow): void {
		if (!this.request.multiSelect) {
			this.context.done({ selections: [], extraId: extra.id, note: this.note });
			return;
		}
		// Extra rows are exclusive: they mean "no real answer given".
		if (this.extraId === extra.id) this.extraId = undefined;
		else {
			this.extraId = extra.id;
			this.selected.clear();
			this.customText = undefined;
		}
		this.refresh();
	}

	private isAnswerable(): boolean {
		return this.selected.size > 0 || Boolean(this.customText) || Boolean(this.extraId);
	}

	private submit(): void {
		if (!this.isAnswerable()) return;
		this.context.done({
			selections: this.orderSelections(),
			customText: this.customText,
			extraId: this.extraId,
			note: this.note,
		});
	}

	/** Selections in the order the options were displayed, not click order. */
	private orderSelections(): ChoiceOption[] {
		const ordered: ChoiceOption[] = [];
		for (const row of this.rows) {
			if (row.kind !== "option") continue;
			const chosen = this.selected.get(row.option.value);
			if (chosen) ordered.push(chosen);
		}
		return ordered;
	}

	// ── input ────────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (this.editMode !== "none") {
			this.handleEditInput(data);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.cursor = Math.max(0, this.cursor - 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.cursor = Math.min(this.rows.length - 1, this.cursor + 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, "n") && this.request.noteEnabled) {
			this.openNoteEditor();
			return;
		}
		if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
			this.activateCurrent(matchesKey(data, Key.enter));
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.context.done(null);
		}
	}

	private handleEditInput(data: string): void {
		const editor = this.editMode === "note" ? this.noteEditor : this.editor;
		if (matchesKey(data, Key.escape)) {
			this.editMode = "none";
			this.refresh();
			return;
		}
		editor.handleInput(data);
		this.refresh();
	}

	private openNoteEditor(): void {
		this.editMode = "note";
		this.noteEditor.setText(this.note ?? "");
		this.refresh();
	}

	private openCustomEditor(): void {
		this.editMode = "custom";
		this.editor.setText(this.customText ?? "");
		this.refresh();
	}

	private activateCurrent(wasEnter: boolean): void {
		const row = this.rows[this.cursor];
		switch (row.kind) {
			case "option":
				if (this.request.multiSelect) this.toggle(row.option);
				else this.context.done({ selections: [row.option], note: this.note });
				return;
			case "custom":
				this.openCustomEditor();
				return;
			case "extra":
				this.chooseExtra(row.extra);
				return;
			case "note":
				this.openNoteEditor();
				return;
			case "submit":
				if (wasEnter) this.submit();
				return;
		}
	}

	// ── rendering ────────────────────────────────────────────────────────────

	invalidate(): void {
		this.cachedLines = undefined;
		this.editor.invalidate?.();
		this.noteEditor.invalidate?.();
	}

	render(width: number): string[] {
		// Width-keyed cache: resize re-enters render() without invalidate().
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const { theme } = this.context;
		const lines: string[] = [];
		const add = (text: string) => lines.push(truncateToWidth(text, width));

		add(theme.fg("accent", "─".repeat(Math.max(1, width))));
		pushWrapped(lines, theme.fg("text", ` ${this.request.title}`), width);
		if (this.request.context) {
			lines.push("");
			pushWrapped(lines, theme.fg("muted", ` ${this.request.context}`), width);
		}
		lines.push("");

		for (let i = 0; i < this.rows.length; i++) {
			this.renderRow(lines, width, this.rows[i], i === this.cursor);
		}

		lines.push("");
		this.renderFooter(lines, width);
		add(theme.fg("accent", "─".repeat(Math.max(1, width))));

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	private renderRow(lines: string[], width: number, row: Row, focused: boolean): void {
		const { theme } = this.context;
		const add = (text: string) => lines.push(truncateToWidth(text, width));
		const marker = focused ? theme.fg("accent", "> ") : "  ";
		const paint = (text: string, done = false) => {
			if (focused) return theme.fg("accent", text);
			return theme.fg(done ? "success" : "text", text);
		};

		switch (row.kind) {
			case "option": {
				const checked = this.selected.has(row.option.value);
				const prefix = this.request.multiSelect ? `${checked ? "[x]" : "[ ]"} ` : `${row.displayIndex}. `;
				add(`${marker}${paint(`${prefix}${row.option.label}`, checked)}`);
				if (row.option.description) {
					pushWrapped(lines, theme.fg("muted", row.option.description), width, "     ");
				}
				return;
			}
			case "custom": {
				const suffix = this.customText ? ` — ${this.customText}` : "";
				add(`${marker}${paint(`${this.request.customAnswerLabel}${suffix}`, Boolean(this.customText))}`);
				return;
			}
			case "extra": {
				const chosen = this.extraId === row.extra.id;
				const prefix = this.request.multiSelect ? `${chosen ? "[x]" : "[ ]"} ` : "";
				add(`${marker}${paint(`${prefix}${row.extra.label}`, chosen)}`);
				if (row.extra.hint) {
					pushWrapped(lines, theme.fg("muted", row.extra.hint), width, "     ");
				}
				return;
			}
			case "note": {
				const suffix = this.note ? ` — ${firstLine(this.note)}` : "";
				add(`${marker}${paint(`Add a note${suffix}`, Boolean(this.note))}`);
				return;
			}
			case "submit": {
				const count = this.selected.size + (this.customText ? 1 : 0) + (this.extraId ? 1 : 0);
				const label = count > 0 ? `Submit (${count} selected)` : "Submit";
				add(`${marker}${paint(label, count > 0)}`);
				return;
			}
		}
	}

	private renderFooter(lines: string[], width: number): void {
		const { theme } = this.context;
		const add = (text: string) => lines.push(truncateToWidth(text, width));

		if (this.editMode !== "none") {
			const editor = this.editMode === "note" ? this.noteEditor : this.editor;
			add(theme.fg("muted", this.editMode === "note" ? " Write a note:" : " Write your answer:"));
			for (const line of editor.render(Math.max(1, width - 2))) add(` ${line}`);
			lines.push("");
			add(theme.fg("dim", " Enter to save • Esc to go back"));
			return;
		}

		if (this.request.multiSelect && !this.isAnswerable()) {
			add(theme.fg("warning", " Select at least one answer, or write your own, before submitting."));
		}

		const hints = ["↑↓ navigate", this.request.multiSelect ? "Space toggle" : "Enter select", "Enter activate"];
		if (this.request.noteEnabled) hints.push("n note");
		hints.push("Esc cancel");
		add(theme.fg("dim", ` ${hints.join(" • ")}`));
	}
}

function firstLine(text: string): string {
	const index = text.indexOf("\n");
	return index === -1 ? text : `${text.slice(0, index)}…`;
}

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
 *
 * And one hard usability constraint: a pop-up renders in the editor slot at the
 * bottom of the screen, so every line it takes is a line of transcript the
 * learner cannot read. A quiz with six described options used to consume the
 * whole screen, leaving two rows of context. Two mechanisms keep that from
 * happening:
 *
 *   - The body is capped to a fraction of the terminal height and the option
 *     list WINDOWS around the cursor with scroll indicators, rather than growing
 *     without bound. Transcript space is therefore never negotiated away.
 *   - `ctrl+o` collapses the whole thing to one line, for when the learner wants
 *     to read the transcript properly and answer afterwards.
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
	/** Short noun for the collapsed row, e.g. "Question" or "Quiz". */
	label?: string;
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

/**
 * Share of the terminal the expanded body may occupy.
 *
 * 0.6 leaves a clear majority of the screen for the transcript even in the worst
 * case, which is the point: the learner is answering a question *about* text
 * they need to be able to see.
 */
const POPUP_HEIGHT_FRACTION = 0.6;

/**
 * Absolute floor for the option list, in rows, when the terminal is very short.
 *
 * Two rows is one option plus its description. Below this the pop-up cannot be
 * answered, which is a worse failure than having little transcript — and
 * collapse is always available to reclaim the transcript.
 */
const MIN_OPTION_ROWS = 2;

/** Key that collapses and expands the body. Free inside a focused component. */
const COLLAPSE_KEY = "ctrl+o";

/** How the collapse shortcut is spelled in the UI. */
const COLLAPSE_LABEL = "ctrl+o collapse";

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

/** Optional chrome rows, so a short terminal can shed the supplementary ones. */
interface ChromeDetails {
	/** Show the `context` line under the question. */
	context: boolean;
	/** Show the "select something first" reminder on multi-select. */
	warning: boolean;
}

interface RenderContext {
	tui: {
		requestRender(): void;
		/** Present in a real terminal; absent in tests, which disables the cap. */
		terminal?: { rows?: number };
	};
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
	ui: {
		custom<T>(
			factory: (tui: unknown, theme: unknown, keybindings: KeybindingsManager, done: (result: T) => void) => unknown,
		): Promise<T>;
	};
}, request: ChoiceRequest): Promise<ChoiceResult | null> {
	return ctx.ui.custom<ChoiceResult | null>((tuiRaw, themeRaw, keybindings, done) => {
		const tui = tuiRaw as RenderContext["tui"];
		const context: RenderContext = {
			// pi's TUI exposes `.terminal`, which carries the live row count; read it
			// through a shallow copy so the height cap stays a pure render-time lookup
			// (and so the tests, which pass no terminal, simply get no cap).
			tui: {
				requestRender: () => tui.requestRender(),
				terminal: tui.terminal,
			},
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
	/** Collapsed to a single summary row so the transcript is readable. */
	private collapsed = false;
	/** Rows scrolled off the top in the last render, for the scroll indicator. */
	private hiddenAbove = 0;
	private hiddenBelow = 0;

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
		// Collapse is reachable in both states and in both edit modes, so it is
		// checked first: the learner may want the transcript back at any point.
		if (matchesKey(data, COLLAPSE_KEY)) {
			this.collapsed = !this.collapsed;
			this.refresh();
			return;
		}
		if (this.collapsed) {
			// Only navigation and collapse make sense on the summary row; ignore
			// everything else rather than acting on a list the learner cannot see.
			if (matchesKey(data, Key.escape)) this.context.done(null);
			return;
		}
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

	/** Terminal height in rows, or `undefined` when unknown (tests). */
	private terminalRows(): number | undefined {
		const rows = this.context.tui.terminal?.rows;
		if (typeof rows !== "number" || !Number.isFinite(rows) || rows <= 0) return undefined;
		return rows;
	}

	/**
	 * Rows available to the option list once the chrome and the transcript share
	 * are accounted for.
	 *
	 * Priority, highest first: (1) the fixed chrome, so the question and key hints
	 * are never lost; (2) at least a couple of option rows, so the pop-up is
	 * answerable at all; (3) leaving most of the screen to the transcript. On a
	 * normal terminal (3) is what binds. On a very short one the earlier
	 * guarantees win and the learner uses collapse to read the transcript — which
	 * is precisely why collapse exists.
	 */
	private availableForOptions(width: number, chrome: number): number {
		const rows = this.terminalRows();
		if (rows === undefined) return Number.POSITIVE_INFINITY;
		// Leave one line clear so pi's own footer/status row is never displaced.
		const usable = Math.max(1, rows - 1);
		const preferred = Math.max(chrome + MIN_OPTION_ROWS, Math.floor(rows * POPUP_HEIGHT_FRACTION));
		return Math.max(MIN_OPTION_ROWS, Math.min(preferred, usable) - chrome);
	}

	/**
	 * Height needed by the fixed chrome: borders, title, context, and footer.
	 *
	 * Measured rather than assumed, because an open inline editor makes the footer
	 * much taller than its hint row. Under-reserving pushes the editor off the
	 * bottom of the terminal, making it unusable exactly when the learner is
	 * typing an answer.
	 */
	private chromeHeight(width: number, details: ChromeDetails): number {
		return this.buildChrome(width, details).height;
	}

	/**
	 * Build the fixed rows and report how tall they are.
	 *
	 * `details` drives graceful degradation on a short terminal: the context line
	 * is supplementary and the "select something first" warning is a reminder, so
	 * both are droppable. The title, the options, and the key hints are not — a
	 * pop-up missing any of those cannot be used.
	 */
	private buildChrome(width: number, details: ChromeDetails): { header: string[]; footer: string[]; height: number } {
		const { theme } = this.context;
		const header: string[] = [];
		pushWrapped(header, theme.fg("text", ` ${this.request.title}`), width);
		if (details.context && this.request.context) {
			header.push("");
			pushWrapped(header, theme.fg("muted", ` ${this.request.context}`), width);
		}
		const footer = this.buildFooter(width, { warning: details.warning });
		// Two border rows, two blank separators, one blank before the footer.
		return { header, footer, height: 5 + header.length + footer.length };
	}

	/**
	 * The chrome detail levels to try, richest first.
	 *
	 * Ordering encodes the priority: keep the context if there is room, then give
	 * it up, then give up the warning reminder. Options and the footer outrank both.
	 */
	private chromeLevels(): ChromeDetails[] {
		const wantsWarning = this.request.multiSelect && !this.isAnswerable() && this.editMode === "none";
		const hasContext = Boolean(this.request.context);
		const levels: ChromeDetails[] = [];
		if (hasContext) levels.push({ context: true, warning: wantsWarning });
		if (wantsWarning) levels.push({ context: false, warning: true });
		levels.push({ context: false, warning: false });
		return levels;
	}

	render(width: number): string[] {
		// Width-keyed cache: resize re-enters render() without invalidate().
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines = this.collapsed ? this.renderCollapsed(width) : this.renderExpanded(width);
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	/** One line: enough to remember what is being asked, and how to get it back. */
	private renderCollapsed(width: number): string[] {
		const { theme } = this.context;
		const label = this.request.label ?? "Question";
		const progress = this.describeProgress();
		const text = `${theme.fg("accent", `▸ ${label}`)}${progress ? theme.fg("muted", ` — ${progress}`) : ""}${theme.fg("dim", `  (${COLLAPSE_LABEL} to expand)`)}`;
		return [truncateToWidth(text, width)];
	}

	/** A short "where am I" summary for the collapsed row. */
	private describeProgress(): string {
		if (this.editMode === "note") return "writing a note";
		if (this.customText) return `own answer: ${firstLine(this.customText)}`;
		if (this.extraId === "unsure") return "I don't know";
		if (this.selected.size > 0) {
			const labels = this.orderSelections().map((option) => option.label);
			return labels.length === 1 ? labels[0] : `${labels.length} selected`;
		}
		const row = this.rows[this.cursor];
		if (row?.kind === "option") return `on ${row.displayIndex}. ${row.option.label}`;
		return firstLine(this.request.title);
	}

	private renderExpanded(width: number): string[] {
		const { theme } = this.context;

		// Pick the richest chrome that leaves room for at least one option. On a
		// normal terminal the richest level wins and nothing is degraded; on a very
		// short one the supplementary rows are shed so the list survives.
		const terminalRows = this.terminalRows();
		let chrome = this.buildChrome(width, { context: Boolean(this.request.context), warning: true });
		if (terminalRows !== undefined) {
			const usable = Math.max(1, terminalRows - 1);
			for (const level of this.chromeLevels()) {
				const candidate = this.buildChrome(width, level);
				chrome = candidate;
				if (candidate.height + MIN_OPTION_ROWS <= usable) break;
			}
		}

		const { header, footer } = chrome;
		this.hiddenAbove = 0;
		this.hiddenBelow = 0;

		const available = this.availableForOptions(width, chrome.height);

		const rowLines: string[][] = this.rows.map((row) => this.renderRowLines(width, row, row === this.rows[this.cursor]));
		const total = rowLines.reduce((sum, block) => sum + block.length, 0);

		let visible: string[];
		if (total <= available) {
			visible = rowLines.flat();
		} else {
			visible = this.windowRows(rowLines, available);
		}

		const border = theme.fg("accent", "─".repeat(Math.max(1, width)));
		const lines: string[] = [border, ...header, "", ...visible, "", ...footer, border];

		// A hard cap as the final guarantee, so an unforeseen tall footer or a
		// wrapped title can never exceed the budget and eat the transcript. The cap
		// trims the CHROME-FREE middle (the windowed option list), never the footer:
		// losing the editor or the key hints is worse than losing an option row,
		// because the list can be scrolled and the footer cannot.
		if (terminalRows !== undefined) {
			const cap = Math.max(1, terminalRows - 1);
			if (lines.length > cap) {
				const overflow = lines.length - cap;
				const footerStart = lines.length - footer.length - 1;
				if (overflow <= footerStart) {
					return [...lines.slice(0, footerStart - overflow), ...lines.slice(footerStart)];
				}
				return lines.slice(0, cap);
			}
		}
		return lines;
	}

	/**
	 * Show the cursor's row plus as many neighbours as fit, counting from the top
	 * of the list when the cursor is high and from the cursor backwards when it is
	 * low. Long option blocks are never split, so an option's description always
	 * travels with its label.
	 */
	private windowRows(rowLines: string[][], available: number): string[] {
		const cursorIndex = this.cursor;
		const cursorBlock = rowLines[cursorIndex] ?? [];
		let used = cursorBlock.length;
		let first = cursorIndex;
		let last = cursorIndex;

		// Grow downward, then upward, so the cursor is always visible and the
		// window stays centred on it when space allows.
		while (last + 1 < rowLines.length && used + rowLines[last + 1].length <= available) {
			last += 1;
			used += rowLines[last].length;
		}
		while (first - 1 >= 0 && used + rowLines[first - 1].length <= available) {
			first -= 1;
			used += rowLines[first].length;
		}

		const shown: string[] = [];
		const theme = this.context.theme;
		if (first > 0) this.hiddenAbove = first;
		if (last < rowLines.length - 1) this.hiddenBelow = rowLines.length - 1 - last;

		// The indicators are inserted after windowing rather than budgeted for, so
		// they can never push a row out of the window.
		if (this.hiddenAbove > 0) shown.push(theme.fg("dim", `  ↑ ${this.hiddenAbove} above`));
		for (let i = first; i <= last; i++) shown.push(...rowLines[i]);
		if (this.hiddenBelow > 0) shown.push(theme.fg("dim", `  ↓ ${this.hiddenBelow} below`));
		return shown;
	}

	private renderRowLines(width: number, row: Row, focused: boolean): string[] {
		const lines: string[] = [];
		this.renderRow(lines, width, row, focused);
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

	private buildFooter(width: number): string[] {
		const lines: string[] = [];
		this.renderFooter(lines, width);
		return lines;
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
		hints.push(COLLAPSE_LABEL);
		hints.push("Esc cancel");
		add(theme.fg("dim", ` ${hints.join(" • ")}`));
	}
}

function firstLine(text: string): string {
	const index = text.indexOf("\n");
	return index === -1 ? text : `${text.slice(0, index)}…`;
}

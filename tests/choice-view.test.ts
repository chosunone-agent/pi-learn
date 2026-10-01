import assert from "node:assert/strict";
import test from "node:test";
import { openChoice, type ChoiceRequest } from "../lib/choice-view.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * A stub environment that runs the component like pi does.
 *
 * The point of these tests is the invariant that crashed the reference
 * implementation: `render(width)` is re-entered with a NEW width on terminal
 * resize without `invalidate()` being called first, and every returned line must
 * fit that width. pi treats an over-wide line as a crash.
 */
function mount(request: ChoiceRequest, options: { rows?: number } = {}) {
	const renders: number[][] = [];
	let doneResult: unknown;
	let component: { render(w: number): string[]; handleInput(d: string): void; invalidate(): void } | undefined;
	let renderCount = 0;

	const theme = {
		fg: (_token: string, text: string) => text,
	};
	// pi supplies a live terminal object; `rows` is what the height cap reads. It
	// is omitted when a test wants the uncapped behaviour.
	const tui = {
		requestRender: () => {},
		...(options.rows === undefined ? {} : { terminal: { rows: options.rows } }),
	};

	const ctx = {
		hasUI: true,
		ui: {
			custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (r: unknown) => void) => unknown) {
				return new Promise((resolve) => {
					const done = (result: unknown) => {
						doneResult = result;
						resolve(result);
					};
					component = factory(tui, theme, {}, done) as typeof component;
				});
			},
		},
	};

	const promise = openChoice(ctx as never, request);
	renders.push([renderCount++]);
	return {
		renderAt(width: number): string[] {
			assert.ok(component, "component was not created");
			return component.render(width);
		},
		input(data: string) {
			assert.ok(component, "component was not created");
			component.handleInput(data);
		},
		invalidate() {
			assert.ok(component, "component was not created");
			component.invalidate();
		},
		async result() {
			return promise;
		},
		get done() {
			return doneResult;
		},
	};
}

const request: ChoiceRequest = {
	label: "Quiz",
	title: "Which planet is the second from the Sun?",
	context: "Think about the order before answering.",
	options: [
		{ label: "Mercury", value: "mercury", description: "Closest to the Sun." },
		{ label: "Venus", value: "venus" },
		{ label: "Earth", value: "earth" },
	],
	multiSelect: false,
	customAnswerLabel: "Type something.",
	extraRows: [{ id: "unsure", label: "I don't know", hint: "Recorded as a signal." }],
	noteEnabled: true,
};

test("every rendered line fits the width it was rendered for", () => {
	// Widths a real terminal can take, including absurdly narrow and very wide.
	for (const width of [1, 2, 5, 20, 40, 80, 120, 200]) {
		const harness = mount(request);
		for (const line of harness.renderAt(width)) {
			assert.ok(
				visibleWidth(line) <= width,
				`a line was ${visibleWidth(line)} cells in a ${width}-cell render: ${JSON.stringify(line)}`,
			);
		}
	}
});

test("re-rendering at a new width does not reuse stale wider lines", () => {
	// The reference implementation cached lines without keying on width, so a
	// resize returned lines built for the old width and crashed pi.
	const harness = mount(request);
	const wide = harness.renderAt(120);
	const narrow = harness.renderAt(30);
	assert.notDeepEqual(wide, narrow, "a width change must produce freshly laid out lines");
	for (const line of narrow) {
		assert.ok(visibleWidth(line) <= 30, `stale line survived the resize: ${JSON.stringify(line)}`);
	}
});

test("the same width renders stably (the cache still works)", () => {
	const harness = mount(request);
	const first = harness.renderAt(80);
	const second = harness.renderAt(80);
	assert.deepEqual(first, second);
});

test("invalidate clears the cache and the next render is fresh", () => {
	const harness = mount(request);
	harness.renderAt(80);
	harness.invalidate();
	const after = harness.renderAt(80);
	assert.ok(after.length > 0);
});

test("narrow widths still render one row per choice instead of dropping rows", () => {
	// The real invariant is that no choice becomes unreachable: truncation may
	// hide characters, but a row must never disappear.
	const harness = mount(request);
	const expectedRows = request.options.length + 3; // custom + unsure + note
	for (const width of [10, 20, 40]) {
		const lines = harness.renderAt(width);
		const rowLines = lines.filter((line) => line.startsWith("> ") || line.startsWith("  "));
		assert.ok(
			rowLines.length >= expectedRows,
			`at width ${width} only ${rowLines.length} of ${expectedRows} rows rendered`,
		);
	}
});

test("long titles and descriptions wrap rather than overflow", () => {
	const longRequest: ChoiceRequest = {
		...request,
		title: "x".repeat(400),
		context: "y".repeat(400),
		options: [{ label: "z".repeat(300), value: "z", description: "w".repeat(300) }],
	};
	const harness = mount(longRequest);
	for (const width of [20, 60, 100]) {
		for (const line of harness.renderAt(width)) {
			assert.ok(visibleWidth(line) <= width, `overflowing line at width ${width}`);
		}
	}
});

test("an empty option list renders as a pure free-text prompt", () => {
	const harness = mount({ title: "Explain in your own words", options: [], multiSelect: false, customAnswerLabel: "Type your answer." });
	const lines = harness.renderAt(60);
	assert.ok(lines.join("\n").includes("Type your answer."));
	for (const line of lines) assert.ok(visibleWidth(line) <= 60);
});

test("escape cancels with null", async () => {
	const harness = mount(request);
	harness.input("\x1b");
	assert.equal(await harness.result(), null);
});

test("selecting an option returns it and its value", async () => {
	const harness = mount(request);
	harness.input("\r"); // Enter on the first option (Mercury)
	const result = (await harness.result()) as { selections: Array<{ value: string }> } | null;
	assert.equal(result?.selections[0]?.value, "mercury");
});

test("moving down then selecting returns the right option", async () => {
	const harness = mount(request);
	harness.input("\x1b[B"); // Down
	harness.input("\r");
	const result = (await harness.result()) as { selections: Array<{ value: string }> } | null;
	assert.equal(result?.selections[0]?.value, "venus");
});

test("the cursor cannot move above the first row or below the last", async () => {
	const harness = mount(request);
	harness.input("\x1b[A"); // Up at the top
	harness.input("\r");
	const up = (await harness.result()) as { selections: Array<{ value: string }> } | null;
	assert.equal(up?.selections[0]?.value, "mercury", "Up at the top must clamp, not wrap or crash");

	const harness2 = mount(request);
	for (let i = 0; i < 50; i++) harness2.input("\x1b[B"); // Down far past the end
	for (let i = 0; i < 50; i++) harness2.input("\x1b[A"); // Back to the top
	harness2.input("\r");
	const down = (await harness2.result()) as { selections: Array<{ value: string }> } | null;
	assert.equal(
		down?.selections[0]?.value,
		"mercury",
		"Down past the end must clamp to the last row, so 50 up must return to the first",
	);
});

test("the uncertain row produces an exclusive outcome, not a selection", async () => {
	const harness = mount(request);
	// Rows: Mercury, Venus, Earth, custom, unsure. Down 4 lands on unsure.
	for (let i = 0; i < 4; i++) harness.input("\x1b[B");
	harness.input("\r");
	const result = (await harness.result()) as { extraId?: string; selections: unknown[] } | null;
	assert.equal(result?.extraId, "unsure");
	assert.deepEqual(result?.selections, [], "an unsure answer must not carry a selection");
});

test("multi-select accumulates and reports display order, not click order", async () => {
	const multi: ChoiceRequest = { ...request, multiSelect: true };
	const harness = mount(multi);
	// Select Earth (row 3) first, then Mercury (row 1).
	harness.input(" ");
	harness.input("\x1b[B");
	harness.input("\x1b[B");
	harness.input(" ");
	// Submit is the last row.
	for (let i = 0; i < 10; i++) harness.input("\x1b[B");
	harness.input("\r");
	const result = (await harness.result()) as { selections: Array<{ value: string }> } | null;
	assert.deepEqual(
		result?.selections.map((s) => s.value),
		["mercury", "earth"],
		"selections must be returned in display order so the transcript is readable",
	);
});

test("multi-select cannot submit with nothing chosen", async () => {
	const multi: ChoiceRequest = { ...request, multiSelect: true };
	const harness = mount(multi);
	for (let i = 0; i < 10; i++) harness.input("\x1b[B"); // to the submit row
	harness.input("\r"); // Submit with nothing selected
	assert.equal(harness.done, undefined, "an empty multi-select submit must be ignored");
	// Settle the still-open dialog so the test leaves nothing pending.
	harness.input("\x1b");
	assert.equal(await harness.result(), null);
});

test("choosing an option after 'I don't know' clears the unsure outcome", async () => {
	const multi: ChoiceRequest = { ...request, multiSelect: true };
	const harness = mount(multi);
	for (let i = 0; i < 4; i++) harness.input("\x1b[B");
	harness.input(" "); // toggle unsure on
	harness.input("\x1b[A"); // back up
	harness.input("\x1b[A");
	harness.input("\x1b[A");
	harness.input("\x1b[A"); // back to Mercury
	harness.input(" "); // select Mercury
	for (let i = 0; i < 10; i++) harness.input("\x1b[B");
	harness.input("\r");
	const result = (await harness.result()) as { extraId?: string; selections: Array<{ value: string }> } | null;
	assert.equal(result?.extraId, undefined, "a real selection must clear the unsure state");
	assert.deepEqual(result?.selections.map((s) => s.value), ["mercury"]);
});

test("rendering never throws across a resize storm", () => {
	// Models a terminal being dragged narrower and wider, which is exactly when
	// the reference implementation crashed.
	const harness = mount(request);
	const widths = [120, 40, 200, 3, 80, 1, 60, 25, 100, 8];
	for (const width of widths) {
		const lines = harness.renderAt(width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `overflow at width ${width}: ${JSON.stringify(line)}`);
		}
	}
});

// ── height budget: the pop-up must never eat the transcript ─────────────────

/**
 * A request that used to consume the whole screen: six options, each with a
 * two-line description, plus every appended row.
 */
const tallRequest: ChoiceRequest = {
	label: "Quiz",
	title: "Which of these statements about compactness is true?",
	context: "Consider what happens as the sequence continues.",
	options: [
		{ label: "A bounded sequence converges", value: "a", description: "Not in general — consider an alternating sequence of 0 and 1." },
		{ label: "Every closed bounded set is compact", value: "b", description: "True in R, via Heine-Borel." },
		{ label: "Compact implies closed", value: "c", description: "True in a Hausdorff space." },
		{ label: "Every sequence has a convergent subsequence", value: "d", description: "Only if the space is sequentially compact." },
		{ label: "Continuous images are compact", value: "e", description: "True — compactness is preserved." },
		{ label: "Compact sets have no limit points", value: "f", description: "False: a compact set can have many." },
	],
	multiSelect: true,
	customAnswerLabel: "Type something.",
	extraRows: [{ id: "unsure", label: "I don't know", hint: "Recorded as a signal, not a wrong answer." }],
	noteEnabled: true,
};

test("the expanded pop-up respects the row budget on a short terminal", () => {
	// This is the reported bug: a tall quiz left ~2 rows of readable transcript.
	for (const rows of [14, 18, 24, 30, 40]) {
		const harness = mount(tallRequest, { rows });
		const lines = harness.renderAt(100);
		assert.ok(
			lines.length <= rows - 1,
			`${rows}-row terminal: pop-up used ${lines.length} lines and covered the screen`,
		);
	}
});

test("a normal terminal keeps a majority of the screen for the transcript", () => {
	// The point of the cap. On a normal terminal the preferred fraction binds, so
	// the learner retains most of the text they are being quizzed about.
	for (const rows of [24, 30, 40, 60]) {
		const harness = mount(tallRequest, { rows });
		const used = harness.renderAt(100).length;
		assert.ok(used <= Math.floor(rows * 0.6) + 1, `${rows}-row terminal: pop-up used ${used} lines`);
		assert.ok(rows - used >= 4, `${rows}-row terminal: only ${rows - used} transcript rows remained`);
	}
});

test("the option list is never consumed entirely by chrome", () => {
	// A terminal short enough that the title, context and footer alone exceed the
	// preferred budget. Options must win over transcript space, because a pop-up
	// with no visible options cannot be answered at all.
	const firstOption = tallRequest.options[0]?.label ?? "";
	for (const rows of [10, 11, 12, 14, 16]) {
		const harness = mount(tallRequest, { rows });
		const text = harness.renderAt(100).join("\n");
		assert.ok(
			text.includes(firstOption),
			`${rows}-row terminal rendered no first option. Got:\n${text}`,
		);
	}
});

test("a very short terminal sheds supplementary chrome before options", () => {
	// The context line is a nicety; the options are the point. Degrading the
	// former to keep the latter is the intended trade at the extreme.
	const harness = mount(tallRequest, { rows: 10 });
	const text = harness.renderAt(100).join("\n");
	assert.ok(text.includes(tallRequest.options[0]?.label ?? ""), "options must survive");
	assert.ok(!text.includes(tallRequest.context ?? "\u0000"), "the context line should be the first thing shed");
});

test("without a terminal height the cap is disabled, not guessed", () => {
	// A missing `rows` must not silently truncate; tests and unusual hosts see
	// the full component.
	const uncapped = mount(tallRequest);
	const capped = mount(tallRequest, { rows: 20 });
	assert.ok(uncapped.renderAt(100).length > capped.renderAt(100).length);
});

test("the collapsed row is a single line", () => {
	const harness = mount(tallRequest, { rows: 20 });
	harness.invalidate();
	harness.input("\x0f"); // ctrl+o
	assert.equal(harness.renderAt(100).length, 1, "collapse must free the transcript");
});

test("collapse toggles back to the expanded view", () => {
	const harness = mount(tallRequest, { rows: 20 });
	const expanded = harness.renderAt(100).length;
	harness.input("\x0f");
	assert.equal(harness.renderAt(100).length, 1);
	harness.input("\x0f");
	assert.equal(harness.renderAt(100).length, expanded, "expanding must restore the full body");
});

test("the collapsed row says what is being asked and how to get back", () => {
	const harness = mount(tallRequest, { rows: 20 });
	harness.input("\x0f");
	const line = harness.renderAt(100)[0] as string;
	assert.ok(line.includes("Quiz"), "the label must identify the pop-up");
	assert.ok(line.includes("ctrl+o"), "the reopen hint must be present");
});

test("the collapsed row reports the cursor position, showing move-then-collapse", () => {
	// Navigation while collapsed is deliberately ignored: the list is invisible,
	// so moving the cursor blind would be a change the learner cannot see. The
	// summary therefore reflects where the cursor was on collapse.
	const harness = mount(tallRequest, { rows: 20 });
	harness.input("\x0f");
	assert.ok(
		(harness.renderAt(100)[0] as string).includes("A bounded sequence converges"),
		"the first row must be reported on collapse",
	);

	const moved = mount(tallRequest, { rows: 20 });
	moved.input("\x1b[B");
	moved.input("\x1b[B");
	moved.input("\x0f");
	const line = moved.renderAt(100)[0] as string;
	assert.ok(line.includes("Compact implies closed"), `expected the new cursor row: ${line}`);
});

test("the collapsed row reports a selection instead of the cursor when one exists", () => {
	const harness = mount(tallRequest, { rows: 20 });
	harness.input(" "); // toggle the first option
	harness.input("\x0f");
	const line = harness.renderAt(100)[0] as string;
	assert.ok(line.includes("A bounded sequence converges"), `expected the selection: ${line}`);
});

test("keys other than escape are ignored while collapsed", () => {
	// Acting on a list the learner cannot see would be a surprising mutation.
	const harness = mount(tallRequest, { rows: 20 });
	harness.input("\x0f");
	const before = harness.renderAt(100)[0] as string;
	harness.input(" "); // would toggle if it leaked through
	harness.input("\r"); // would submit if it leaked through
	harness.input("\x1b[B");
	assert.equal(harness.done, undefined, "no answer may be submitted while collapsed");
	assert.equal(harness.renderAt(100)[0], before, "state must not change while collapsed");
});

test("escape still cancels while collapsed", async () => {
	const harness = mount(tallRequest, { rows: 20 });
	harness.input("\x0f");
	harness.input("\x1b");
	assert.equal(await harness.result(), null);
});

test("the cursor's option is always visible when the list is windowed", () => {
	// The window must follow the cursor to the very last row, or a long list
	// becomes partially unreachable.
	for (const rows of [12, 16, 20, 26]) {
		const harness = mount(tallRequest, { rows });
		for (let i = 0; i < tallRequest.options.length + 3; i++) {
			const text = harness.renderAt(100).join("\n");
			const expected = expectedRowText(tallRequest, i);
			if (expected !== undefined) {
				assert.ok(text.includes(expected), `rows=${rows} cursor=${i}: focused row "${expected}" was not visible`);
			}
			harness.input("\x1b[B");
		}
	}
});

test("windowed rendering shows a scroll indicator for the hidden rows", () => {
	const harness = mount(tallRequest, { rows: 14 });
	const top = harness.renderAt(100).join("\n");
	assert.ok(/↓ \d+ below/.test(top), `expected a 'below' indicator at the top of a long list:\n${top}`);

	for (let i = 0; i < tallRequest.options.length + 3; i++) harness.input("\x1b[B");
	const bottom = harness.renderAt(100).join("\n");
	assert.ok(/↑ \d+ above/.test(bottom), `expected an 'above' indicator at the bottom of a long list:\n${bottom}`);
});

test("a very short terminal still leaves pi's own footer room", () => {
	// The pop-up replaces the editor slot; consuming every row would push pi's
	// status line off the screen.
	for (const rows of [8, 10, 12, 16, 20]) {
		const harness = mount(tallRequest, { rows });
		assert.ok(harness.renderAt(100).length <= rows - 1, `${rows}-row terminal used every row`);
	}
});

test("a long option block is never split across the window boundary", () => {
	// A label separated from its description is worse than a hidden option.
	const harness = mount(tallRequest, { rows: 12 });
	const text = harness.renderAt(100).join("\n");
	const lines = text.split("\n");
	for (const option of tallRequest.options) {
		const labelAt = lines.findIndex((line) => line.includes(option.label));
		if (labelAt === -1) continue;
		if (option.description === undefined) continue;
		assert.ok(
			lines[labelAt + 1]?.includes(option.description),
			`description for "${option.label}" was separated from its label`,
		);
	}
});

test("the height cap does not change what an answer resolves to", async () => {
	// The cap is presentational: grading and the returned values must be identical
	// whether or not the pop-up was windowed.
	const capped = mount(tallRequest, { rows: 14 });
	capped.input("\x1b[B");
	capped.input(" ");
	for (let i = 0; i < 20; i++) capped.input("\x1b[B");
	capped.input("\r");
	const cappedResult = (await capped.result()) as { selections: Array<{ value: string }> } | null;

	const uncapped = mount(tallRequest);
	uncapped.input("\x1b[B");
	uncapped.input(" ");
	for (let i = 0; i < 20; i++) uncapped.input("\x1b[B");
	uncapped.input("\r");
	const uncappedResult = (await uncapped.result()) as { selections: Array<{ value: string }> } | null;

	assert.deepEqual(cappedResult?.selections, uncappedResult?.selections);
	assert.deepEqual(cappedResult?.selections?.map((s) => s.value), ["b"]);
});

/** The row text the cursor should be showing at `cursorIndex`, for assertions. */
function expectedRowText(req: ChoiceRequest, cursorIndex: number): string | undefined {
	const rows: string[] = req.options.map((option) => option.label);
	if (req.customAnswerLabel) rows.push(req.customAnswerLabel);
	for (const extra of req.extraRows ?? []) rows.push(extra.label);
	if (req.noteEnabled) rows.push("Add a note");
	if (req.multiSelect) rows.push("Submit");
	return rows[cursorIndex];
}

test("collapsing mid-note preserves the draft and resumes editing", () => {
	// Collapse is reachable while editing, so the draft must survive the round
	// trip — losing typed text to a display toggle would be indefensible.
	const harness = mount(request, { rows: 20 });
	harness.input("n"); // open the note editor
	harness.input("half a thought");
	assert.ok(harness.renderAt(80).join("\n").includes("Enter to save"), "the note editor should be open");

	harness.input("\x0f"); // collapse mid-edit
	const collapsed = harness.renderAt(80);
	assert.equal(collapsed.length, 1);
	assert.ok((collapsed[0] as string).includes("writing a note"), `expected an in-progress hint: ${collapsed[0]}`);

	harness.input("\x0f"); // expand again
	const expanded = harness.renderAt(80).join("\n");
	assert.ok(expanded.includes("half a thought"), "the typed draft must still be in the editor");
	assert.ok(expanded.includes("Enter to save"), "editing must resume, not silently end");
});

test("collapsing after a multi-selection reports the count", () => {
	const harness = mount(tallRequest, { rows: 20 });
	harness.input(" "); // toggle option 1
	harness.input("\x1b[B");
	harness.input(" "); // toggle option 2
	harness.input("\x1b[B"); // move off, so the summary cannot be the cursor row
	harness.input("\x0f");
	const line = harness.renderAt(100)[0] as string;
	assert.ok(line.includes("2 selected"), `expected a count of the selection: ${line}`);
});

test("collapse does not change the outcome of a deliberate answer", async () => {
	// The display state must not leak into the result.
	const harness = mount(request, { rows: 20 });
	harness.input("\x0f"); // collapse
	harness.input("\x0f"); // expand
	harness.input("\x1b[B"); // to Venus
	harness.input("\r");
	const result = (await harness.result()) as { selections: Array<{ value: string }> } | null;
	assert.deepEqual(result?.selections.map((s) => s.value), ["venus"]);
});

test("windowed rendering still fits the width on every terminal size", () => {
	for (const rows of [10, 14, 20, 30]) {
		for (const width of [40, 80, 120]) {
			const harness = mount(tallRequest, { rows });
			for (let i = 0; i < tallRequest.options.length + 3; i++) {
				const lines = harness.renderAt(width);
				assert.ok(lines.length <= rows - 1, `rows=${rows} width=${width}: used ${lines.length} rows`);
				for (const line of lines) {
					assert.ok(visibleWidth(line) <= width, `rows=${rows} width=${width}: ${JSON.stringify(line)}`);
				}
				harness.input("\x1b[B");
			}
		}
	}
});

test("an open editor is never truncated away by the height cap", () => {
	// Regression: the cap used to cut the inline editor and its key hints off the
	// bottom, so typing an answer was impossible on a short terminal.
	for (const rows of [10, 12, 16, 20, 30]) {
		for (const width of [60, 100]) {
			const harness = mount(tallRequest, { rows });
			harness.input("n"); // open the note editor
			harness.input("draft");
			const text = harness.renderAt(width).join("\n");
			assert.ok(text.includes("Write a note"), `rows=${rows}: the editor label was truncated away`);
			assert.ok(text.includes("draft"), `rows=${rows}: the typed draft was truncated away`);
			assert.ok(text.includes("Enter to save"), `rows=${rows}: the save hint was truncated away`);
			assert.ok(text.includes("Esc to go back"), `rows=${rows}: the escape hint was truncated away`);
		}
	}
});

test("the editor stays usable after collapsing and expanding", () => {
	const harness = mount(tallRequest, { rows: 12 });
	harness.input("n");
	harness.input("abc");
	harness.input("\x0f");
	harness.input("\x0f");
	const text = harness.renderAt(100).join("\n");
	assert.ok(text.includes("abc"), "the draft must survive the collapse round trip");
	assert.ok(text.includes("Enter to save"));
});

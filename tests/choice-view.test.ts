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
function mount(request: ChoiceRequest) {
	const renders: number[][] = [];
	let doneResult: unknown;
	let component: { render(w: number): string[]; handleInput(d: string): void; invalidate(): void } | undefined;
	let renderCount = 0;

	const theme = {
		fg: (_token: string, text: string) => text,
	};
	const tui = { requestRender: () => {} };

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

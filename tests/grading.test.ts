import assert from "node:assert/strict";
import test from "node:test";
import { displayOrder, grade, mulberry32, normalizeCorrectAnswer, shuffle, unknownCorrectValues, type QuizOption } from "../lib/grading.ts";

const options: QuizOption[] = [
	{ label: "Mercury", value: "mercury" },
	{ label: "Venus", value: "venus" },
	{ label: "Earth", value: "earth" },
];

test("a correct single selection grades correct", () => {
	const result = grade({ options, selected: ["venus"], correct: ["venus"], multiSelect: false, unsure: false });
	assert.equal(result.verdict, "correct");
});

test("a wrong single selection grades incorrect and names the right index", () => {
	const result = grade({ options, selected: ["earth"], correct: ["venus"], multiSelect: false, unsure: false });
	assert.equal(result.verdict, "incorrect");
	assert.deepEqual(result.correctIndices, [2]);
	assert.deepEqual(result.extraIndices, [3]);
	assert.deepEqual(result.missedIndices, [2]);
});

test("'I don't know' is its own verdict, never incorrect", () => {
	// This is the load-bearing pedagogical commitment: punishing honesty here
	// would make the learner's most informative answer look like a wrong guess.
	const result = grade({ options, selected: [], correct: ["venus"], multiSelect: false, unsure: true });
	assert.equal(result.verdict, "unsure");
	assert.notEqual(result.verdict, "incorrect");
});

test("an empty selection without 'I don't know' is also unsure, not incorrect", () => {
	const result = grade({ options, selected: [], correct: ["venus"], multiSelect: false, unsure: false });
	assert.equal(result.verdict, "unsure");
});

test("'I don't know' short-circuits even when a selection was also made", () => {
	// The UI clears selections when the unsure row is chosen, but grading must
	// not depend on the UI having done that.
	const result = grade({ options, selected: ["venus"], correct: ["venus"], multiSelect: false, unsure: true });
	assert.equal(result.verdict, "unsure");
});

test("multi-select requires an exact set match", () => {
	const correct = ["mercury", "venus"];
	const exact = grade({ options, selected: ["venus", "mercury"], correct, multiSelect: true, unsure: false });
	assert.equal(exact.verdict, "correct", "order must not matter");

	const partial = grade({ options, selected: ["mercury"], correct, multiSelect: true, unsure: false });
	assert.equal(partial.verdict, "incorrect");
	assert.deepEqual(partial.missedIndices, [2]);

	const superset = grade({ options, selected: ["mercury", "venus", "earth"], correct, multiSelect: true, unsure: false });
	assert.equal(superset.verdict, "incorrect", "an extra pick makes it wrong");
	assert.deepEqual(superset.extraIndices, [3]);
});

test("grading uses values, not positions, so shuffling cannot change the verdict", () => {
	const correct = ["earth"];
	for (let seed = 0; seed < 50; seed++) {
		const displayed = displayOrder(options, true, mulberry32(seed));
		// Whatever order the learner saw, the value they picked is the value that
		// grades correct.
		const result = grade({ options, selected: ["earth"], correct, multiSelect: false, unsure: false });
		assert.equal(result.verdict, "correct", `seed ${seed}`);
		assert.ok(displayed.some((option) => option.value === "earth"));
	}
});

test("indices are 1-based and anchored to the authored option list", () => {
	const result = grade({ options, selected: ["mercury"], correct: ["mercury"], multiSelect: false, unsure: false });
	assert.deepEqual(result.correctIndices, [1]);
	assert.deepEqual(result.selectedIndices, [1]);
});

test("unknown selected values are ignored rather than throwing", () => {
	const result = grade({ options, selected: ["pluto"], correct: ["venus"], multiSelect: false, unsure: false });
	assert.deepEqual(result.selectedIndices, []);
	assert.equal(result.verdict, "incorrect");
});

test("shuffle is a permutation and does not mutate the input", () => {
	const original = [...options];
	const shuffled = shuffle(options, mulberry32(7));
	assert.deepEqual(options, original, "shuffle must not mutate its argument");
	assert.equal(shuffled.length, options.length);
	assert.deepEqual(
		shuffled.map((option) => option.value).sort(),
		options.map((option) => option.value).sort(),
	);
});

test("mulberry32 is deterministic and stays in [0,1)", () => {
	const a = mulberry32(12345);
	const b = mulberry32(12345);
	for (let i = 0; i < 100; i++) {
		const value = a();
		assert.equal(value, b(), "same seed must produce the same stream");
		assert.ok(value >= 0 && value < 1, `value out of range: ${value}`);
	}
});

test("shuffling is reproducible from the recorded seed", () => {
	// The log records the seed; without this property a logged quiz could not be
	// reconstructed to match what the learner saw.
	const first = displayOrder(options, true, mulberry32(999));
	const second = displayOrder(options, true, mulberry32(999));
	assert.deepEqual(first, second);
});

test("displayOrder preserves authored order exactly when not shuffling", () => {
	const ordered = displayOrder(options, false, mulberry32(1));
	assert.deepEqual(ordered.map((option) => option.value), ["mercury", "venus", "earth"]);
	assert.deepEqual(ordered.map((option) => option.index), [1, 2, 3]);
});

test("displayOrder actually can reorder, so the shuffle is not a no-op", () => {
	const orders = new Set<string>();
	for (let seed = 0; seed < 30; seed++) {
		orders.add(displayOrder(options, true, mulberry32(seed)).map((o) => o.value).join(","));
	}
	assert.ok(orders.size > 1, "shuffle produced only one distinct order; the PRNG or Fisher-Yates is broken");
});

test("grading agrees with the display order across many shuffles", () => {
	// The regression that produced a false ✓ in the terminal: grading against the
	// authored order while the feedback indexed the display order. For every
	// shuffle, the index reported as correct must point at the option whose VALUE
	// is correct.
	const correct = ["venus"];
	for (let seed = 0; seed < 200; seed++) {
		const displayed = displayOrder(options, true, mulberry32(seed));
		const result = grade({ options: displayed, selected: correct, correct, multiSelect: false, unsure: false });
		assert.equal(result.verdict, "correct", `seed ${seed} verdict`);
		const marked = displayed[(result.correctIndices[0] as number) - 1];
		assert.equal(
			marked?.value,
			"venus",
			`seed ${seed}: index ${result.correctIndices[0]} points at ${marked?.value}, not the correct value`,
		);
		const selectedOption = displayed[(result.selectedIndices[0] as number) - 1];
		assert.equal(selectedOption?.value, "venus", `seed ${seed}: selected index points at the wrong option`);
	}
});

test("grading against the authored order after a shuffle is detectably wrong", () => {
	// Guards the specific mistake: it must not be possible for the display-order
	// and authored-order inputs to agree by luck on every shuffle, or the
	// regression test above would be vacuous.
	const authored = options;
	const correct = ["venus"];
	let disagreements = 0;
	for (let seed = 0; seed < 50; seed++) {
		const displayed = displayOrder(options, true, mulberry32(seed));
		const viaDisplay = grade({ options: displayed, selected: correct, correct, multiSelect: false, unsure: false });
		const viaAuthored = grade({ options: authored, selected: correct, correct, multiSelect: false, unsure: false });
		const displayMark = displayed[(viaDisplay.correctIndices[0] as number) - 1]?.value;
		const authoredMark = displayed[(viaAuthored.correctIndices[0] as number) - 1]?.value;
		if (displayMark !== authoredMark) disagreements += 1;
	}
	assert.ok(disagreements > 0, "the two orders never disagreed; the test cannot detect the regression");
});

test("display indices stay in range for every shuffle", () => {
	for (let seed = 0; seed < 100; seed++) {
		const displayed = displayOrder(options, true, mulberry32(seed));
		const result = grade({ options: displayed, selected: ["earth"], correct: ["venus"], multiSelect: false, unsure: false });
		for (const index of [...result.correctIndices, ...result.selectedIndices]) {
			assert.ok(index >= 1 && index <= displayed.length, `index ${index} out of range for ${displayed.length} options`);
		}
	}
});

test("normalizeCorrectAnswer handles a single value, a list, and junk", () => {
	assert.deepEqual(normalizeCorrectAnswer("venus"), ["venus"]);
	assert.deepEqual(normalizeCorrectAnswer(["a", " b "]), ["a", "b"]);
	assert.deepEqual(normalizeCorrectAnswer([]), []);
	assert.deepEqual(normalizeCorrectAnswer(undefined), []);
	assert.deepEqual(normalizeCorrectAnswer("  "), []);
});

test("unknownCorrectValues catches the common model mistake of passing positions", () => {
	// A model that passes correctAnswer="2" means "the second option" but the
	// value is a label. Reporting it precisely is far better than silently
	// marking every answer wrong.
	assert.deepEqual(unknownCorrectValues(options, ["2"]), ["2"]);
	assert.deepEqual(unknownCorrectValues(options, ["venus"]), []);
	assert.deepEqual(unknownCorrectValues(options, ["venus", "pluto"]), ["pluto"]);
});

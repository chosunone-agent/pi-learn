/**
 * Grading and option presentation for `teach_quiz`.
 *
 * Pure functions only, so the interesting behaviour is directly testable: what
 * counts as correct, how "I don't know" is kept distinct from a wrong answer,
 * and how shuffling stays reviewable after the fact.
 */

/** A model-authored, gradeable option. */
export interface QuizOption {
	label: string;
	value: string;
	description?: string;
}

/** An option as the learner actually saw it. */
export interface DisplayOption extends QuizOption {
	/** 1-based position in the displayed order. */
	index: number;
}

export type Verdict = "correct" | "incorrect" | "unsure";

export interface GradeInput {
	/**
	 * Options in the order the learner SAW them.
	 *
	 * Every index this module returns is a 1-based position in this array, so the
	 * caller must pass the display order, not the authored order. Passing the
	 * authored order after a shuffle silently mislabels which option was correct
	 * — a false assertion in the feedback, which is the worst failure this system
	 * can produce.
	 */
	options: QuizOption[];
	/** Option values chosen by the learner. */
	selected: string[];
	/** The correct value(s), as authored. */
	correct: string[];
	multiSelect: boolean;
	/** True when the learner used the "I don't know" row. */
	unsure: boolean;
}

export interface GradeResult {
	verdict: Verdict;
	/** Displayed options marked, for the transcript and for feedback. */
	correctIndices: number[];
	selectedIndices: number[];
	/** Correct options the learner did not select (multi-select diagnostics). */
	missedIndices: number[];
	/** Options the learner selected that are not correct (multi-select diagnostics). */
	extraIndices: number[];
}

/**
 * Deterministic PRNG (mulberry32). Shuffling must be reproducible for a given
 * seed so a quiz can be re-displayed identically from its recorded seed;
 * `Math.random()` would make the transcript unreconstructable.
 */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Fisher–Yates using an injected generator. Returns a new array. */
export function shuffle<T>(items: T[], random: () => number): T[] {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}

/**
 * Order options for display. When `shuffle` is false the authored order is a
 * meaningful sequence (numeric values, "all of the above") and is preserved
 * exactly.
 */
export function displayOrder(options: QuizOption[], doShuffle: boolean, random: () => number): DisplayOption[] {
	const ordered = doShuffle ? shuffle(options, random) : [...options];
	return ordered.map((option, i) => ({ ...option, index: i + 1 }));
}

/**
 * Grade a response.
 *
 * `input.options` must be in display order: every returned index is a 1-based
 * position in that array, and it is used to mark `displayedOptions` in the
 * feedback and the log. Passing the authored order when the options were
 * shuffled points the ✓/✗ marks at the wrong options.
 *
 * "I don't know" short-circuits to its own verdict. Treating it as merely
 * incorrect would make the learner's most informative answer — *this didn't
 * land* — indistinguishable from a confident wrong guess, and would punish
 * honesty in exactly the system meant to encourage it.
 */
export function grade(input: GradeInput): GradeResult {
	const indexOf = new Map(input.options.map((option, i) => [option.value, i + 1]));
	const correctIndices = input.correct
		.map((value) => indexOf.get(value))
		.filter((index): index is number => index !== undefined)
		.sort((a, b) => a - b);
	const selectedIndices = input.selected
		.map((value) => indexOf.get(value))
		.filter((index): index is number => index !== undefined)
		.sort((a, b) => a - b);

	const selectedSet = new Set(input.selected);
	const correctSet = new Set(input.correct);

	const missedIndices = correctIndices.filter((index) => {
		const value = valueAt(input.options, index);
		return value !== undefined && !selectedSet.has(value);
	});
	const extraIndices = selectedIndices.filter((index) => {
		const value = valueAt(input.options, index);
		return value !== undefined && !correctSet.has(value);
	});

	if (input.unsure) {
		return { verdict: "unsure", correctIndices, selectedIndices, missedIndices, extraIndices };
	}
	if (input.selected.length === 0) {
		// No selection and no "I don't know" is an incomplete answer, not a wrong one.
		return { verdict: "unsure", correctIndices, selectedIndices, missedIndices, extraIndices };
	}

	const isExact =
		selectedSet.size === correctSet.size && [...selectedSet].every((value) => correctSet.has(value));
	return {
		verdict: isExact ? "correct" : "incorrect",
		correctIndices,
		selectedIndices,
		missedIndices,
		extraIndices,
	};
}

function valueAt(options: QuizOption[], index1Based: number): string | undefined {
	return options[index1Based - 1]?.value;
}

/**
 * Read a `correctAnswer` parameter that may be a single value or a list.
 * Always returns an array; multi-select callers get a set-like comparison.
 */
export function normalizeCorrectAnswer(raw: string | string[] | undefined): string[] {
	if (raw === undefined) return [];
	if (Array.isArray(raw)) return raw.map((value) => String(value).trim()).filter(Boolean);
	const trimmed = String(raw).trim();
	return trimmed.length > 0 ? [trimmed] : [];
}

/**
 * Validate that every declared correct value exists among the options.
 * Returns the unknown values so the caller can report them precisely instead of
 * silently grading everything wrong.
 */
export function unknownCorrectValues(options: QuizOption[], correct: string[]): string[] {
	const known = new Set(options.map((option) => option.value));
	return correct.filter((value) => !known.has(value));
}

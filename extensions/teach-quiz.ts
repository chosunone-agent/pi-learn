/**
 * `teach_quiz` — a graded question.
 *
 * Sibling of `teach_ask`, and the difference is the whole point: `teach_ask`
 * has no right answer, `teach_quiz` has exactly one and says so. The learner
 * gets immediate feedback (✓/✗/?) with the correct option and an explanation;
 * the teacher gets a graded record it can build the next move on.
 *
 * Three design commitments inherited from the reference system because they are
 * right, and made explicit here because they are easy to lose:
 *
 *   - "I don't know" is a first-class outcome. It is never shuffled, never
 *     counted as wrong, and reaches the teacher as its own signal.
 *   - The explanation is required. A quiz that grades without teaching is a
 *     test; the explanation is what makes a wrong answer useful.
 *   - Shuffling is seeded and recorded. The options the learner actually saw
 *     are echoed back in display order, so a log entry stays faithful to the
 *     screen even though the authored order was different.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { openChoice, type ChoiceResult } from "../lib/choice-view.ts";
import {
	type DisplayOption,
	type GradeResult,
	displayOrder,
	grade,
	mulberry32,
	normalizeCorrectAnswer,
	unknownCorrectValues,
} from "../lib/grading.ts";
import { normalizeOptions, validateOptions } from "../lib/question-schema.ts";
import { registerInteractiveToolReconciler } from "../lib/reconcile-tools.ts";
import { withUiLock } from "../lib/ui-lock.ts";

type QuizStatus = "answered" | "cancelled" | "unavailable";

export interface TeachQuizDetails {
	status: QuizStatus;
	question: string;
	context?: string;
	multiSelect: boolean;
	/** Options in the order the learner saw them, after any shuffle. */
	displayedOptions: DisplayOption[];
	correctIndices: number[];
	selectedIndices: number[];
	missedIndices: number[];
	extraIndices: number[];
	verdict?: "correct" | "incorrect" | "unsure";
	/** Note the learner attached, when any. */
	note?: string;
	explanation?: string;
	/** Seed used for shuffling, so the display order is reproducible. */
	seed?: number;
	message?: string;
}

const UNSure_ID = "unsure";
const UNSure_LABEL = "I don't know";

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the answer option." }),
	value: Type.Optional(Type.String({ description: "Stable machine-readable value. Defaults to the label." })),
	description: Type.Optional(Type.String({ description: "Optional extra detail shown under the option." })),
});

const TeachQuizParams = Type.Object({
	question: Type.String({ description: "The single quiz question. Exactly one question per call." }),
	context: Type.Optional(Type.String({ description: "Optional context shown under the question." })),
	options: Type.Array(OptionSchema, {
		description: "The answer options (2 or more). Give each a stable value and address it by value in correctAnswer.",
		minItems: 2,
	}),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Set true when several options are correct and the learner must select all of them." }),
	),
	correctAnswer: Type.Union([Type.String(), Type.Array(Type.String())], {
		description:
			'REQUIRED. The correct option value(s): a string for single-select, an array for multi-select. Always pass the value, never a position — positions shift when options are shuffled.',
	}),
	explanation: Type.String({
		description:
			"REQUIRED. Shown after answering, right or wrong. Explain WHY the correct answer is correct, and ideally why the tempting wrong one is wrong.",
	}),
	shuffle: Type.Optional(
		Type.Boolean({
			description:
				"Defaults to true. Set false only when order carries meaning (numeric sequences, 'all of the above' that must stay last).",
		}),
	),
});

function buildDetails(
	status: QuizStatus,
	params: { question: string; context?: string; explanation?: string },
	multiSelect: boolean,
	displayed: DisplayOption[],
	graded: GradeResult | undefined,
	extra: { note?: string; seed?: number; message?: string } = {},
): TeachQuizDetails {
	return {
		status,
		question: params.question,
		context: params.context,
		explanation: params.explanation,
		multiSelect,
		displayedOptions: displayed,
		correctIndices: graded?.correctIndices ?? [],
		selectedIndices: graded?.selectedIndices ?? [],
		missedIndices: graded?.missedIndices ?? [],
		extraIndices: graded?.extraIndices ?? [],
		verdict: graded?.verdict,
		note: extra.note,
		seed: extra.seed,
		message: extra.message,
	};
}

function envelope(details: TeachQuizDetails): string {
	if (details.status === "cancelled") return "User skipped the quiz.";
	if (details.status === "unavailable") return details.message ?? "Quiz could not be shown.";
	const verdict = details.verdict ?? "unsure";
	const lines = [
		`verdict: ${verdict}`,
		`selected: ${details.selectedIndices.join(", ") || "(none)"}`,
		`correct: ${details.correctIndices.join(", ")}`,
	];
	if (verdict === "incorrect" && details.missedIndices.length > 0) lines.push(`missed: ${details.missedIndices.join(", ")}`);
	if (verdict === "incorrect" && details.extraIndices.length > 0) lines.push(`wrong picks: ${details.extraIndices.join(", ")}`);
	if (details.note) lines.push(`note: ${details.note}`);
	return lines.join("\n");
}

export default function teachQuiz(pi: ExtensionAPI) {
	// Keep the tool out of the model's list when there is no UI to render it in.
	registerInteractiveToolReconciler(pi, ["teach_quiz"]);

	pi.registerTool({
		name: "teach_quiz",
		label: "Teach: quiz",
		description:
			"Ask one graded question and give instant feedback. Use it to check that a specific fact or derivation actually landed, after the learner has had a chance to think — not as the first move on brand-new material. The learner sees ✓/✗ (or 'I don't know'), the correct option, and your explanation. 'I don't know' is always available and is recorded as its own signal, never as a wrong answer. Options are shuffled by default so the correct position can't be memorised; pass the correct answers by VALUE, not position.",
		promptSnippet: "Ask one graded question with a known correct answer and immediate feedback.",
		promptGuidelines: [
			"Ask exactly one question per call.",
			"Always pass correctAnswer as the option's value, never as a position number.",
			"explanation is required: say why the right answer is right, and why the tempting wrong one is wrong.",
			"Use teach_quiz only after the material has been taught; use teach_ask to probe before teaching.",
			"Set shuffle=false only when the option order is itself meaningful.",
			"'I don't know' is a legitimate outcome, not a failure — never design a question so guessing beats admitting ignorance.",
		],
		parameters: TeachQuizParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const question = params.question.trim();
			const context = params.context?.trim() || undefined;
			const explanation = params.explanation.trim();
			const multiSelect = params.multiSelect === true;
			const options = normalizeOptions(params.options);
			const correct = normalizeCorrectAnswer(params.correctAnswer as string | string[] | undefined);
			const doShuffle = params.shuffle !== false;

			const base = { question, context, explanation };

			if (options.length < 2) {
				return errorResult(buildDetails("cancelled", base, multiSelect, [], undefined, {
					message: "teach_quiz needs at least 2 options.",
				}));
			}
			const validation = validateOptions(options, 2);
			if (!validation.ok) {
				return errorResult(buildDetails("cancelled", base, multiSelect, [], undefined, { message: validation.message }));
			}
			const unknown = unknownCorrectValues(options, correct);
			if (unknown.length > 0) {
				return errorResult(buildDetails("cancelled", base, multiSelect, [], undefined, {
					message: `correctAnswer refers to values that are not options: ${unknown.join(", ")}. Pass the option's value.`,
				}));
			}
			if (correct.length === 0) {
				return errorResult(buildDetails("cancelled", base, multiSelect, [], undefined, {
					message: "correctAnswer is required.",
				}));
			}
			if (!multiSelect && correct.length > 1) {
				return errorResult(buildDetails("cancelled", base, multiSelect, [], undefined, {
					message: `correctAnswer lists ${correct.length} values but multiSelect is not set.`,
				}));
			}
			if (signal?.aborted) {
				return cancelledResult(buildDetails("cancelled", base, multiSelect, []));
			}
			if (!ctx.hasUI) {
				return errorResult(buildDetails("unavailable", base, multiSelect, [], undefined, {
					message: "teach_quiz needs an interactive terminal.",
				}));
			}

			const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
			const displayed = displayOrder(options, doShuffle, mulberry32(seed));

			// Emit the post-shuffle order BEFORE blocking on the answer. The log
			// extension listens for this update; without it a live log would show the
			// authored order, which is not what the learner is looking at.
			onUpdate?.({
				content: [{ type: "text" as const, text: `Waiting for an answer to: ${question}` }],
				details: {
					options: displayed.map((option) => ({ index: option.index, label: option.label })),
					correctIndices: displayed
						.filter((option) => correct.includes(option.value))
						.map((option) => option.index),
					seed,
				},
			});

			const result: ChoiceResult | null = await withUiLock(() =>
				openChoice(ctx, {
					title: question,
					context,
					options: displayed,
					multiSelect,
					extraRows: [{ id: UNSure_ID, label: UNSure_LABEL, hint: "Recorded as its own signal, not as a wrong answer." }],
					noteEnabled: true,
				}),
			);

			if (!result) {
				return cancelledResult(buildDetails("cancelled", base, multiSelect, displayed, undefined, { seed }));
			}

			const selectedValues = result.selections.map((selection) => selection.value);
			// Grade against the DISPLAY order, because `displayed` is what renderResult
			// and the log index into. Grading against the authored order instead would
			// mark the wrong option as correct after a shuffle.
			const graded = grade({
				options: displayed,
				selected: selectedValues,
				correct,
				multiSelect,
				unsure: result.extraId === UNSure_ID,
			});

			const details = buildDetails("answered", base, multiSelect, displayed, graded, {
				note: result.note,
				seed,
			});
			return {
				content: [{ type: "text" as const, text: envelope(details) }],
				details,
			};
		},

		renderCall(args, theme) {
			const multiSelect = args.multiSelect === true;
			const options = normalizeOptions(args.options as never);
			let text =
				theme.fg("toolTitle", theme.bold("teach_quiz ")) +
				theme.fg("text", args.question) +
				(multiSelect ? theme.fg("dim", " [multi]") : "");
			text += `\n${theme.fg("dim", `  ${options.length} options • answer: ${formatCorrect(args.correctAnswer)}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as TeachQuizDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.status === "cancelled") return new Text(theme.fg("warning", "Skipped"), 0, 0);
			if (details.status === "unavailable") return new Text(theme.fg("warning", details.message ?? "Unavailable"), 0, 0);

			const lines: string[] = [];
			const selectedSet = new Set(details.selectedIndices);
			const correctSet = new Set(details.correctIndices);

			for (const option of details.displayedOptions) {
				const isCorrect = correctSet.has(option.index);
				const isSelected = selectedSet.has(option.index);
				let marker: string;
				if (isCorrect && isSelected) marker = theme.fg("success", "✓");
				else if (isCorrect) marker = theme.fg("dim", "○");
				else if (isSelected) marker = theme.fg("error", "✗");
				else marker = " ";
				const labelColor = isSelected ? (isCorrect ? "success" : "error") : isCorrect ? "muted" : "text";
				lines.push(`${marker} ${theme.fg(labelColor, `${option.index}. ${option.label}`)}`);
			}

			switch (details.verdict) {
				case "correct":
					lines.push(theme.fg("success", "Correct."));
					break;
				case "incorrect":
					lines.push(theme.fg("error", `Incorrect — correct answer: ${details.correctIndices.join(", ")}.`));
					break;
				default:
					lines.push(theme.fg("dim", "Not answered — recorded as 'I don't know'."));
					break;
			}
			if (details.note) lines.push(theme.fg("muted", `note: ${firstLine(details.note)}`));
			if (details.explanation) lines.push(theme.fg("muted", details.explanation));
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

function formatCorrect(raw: unknown): string {
	const values = normalizeCorrectAnswer(raw as string | string[] | undefined);
	return values.length > 0 ? values.join(", ") : "(unset)";
}

function firstLine(text: string): string {
	const index = text.indexOf("\n");
	return index === -1 ? text : `${text.slice(0, index)}…`;
}

function cancelledResult(details: TeachQuizDetails) {
	return {
		content: [{ type: "text" as const, text: "User skipped the quiz." }],
		details,
	};
}

function errorResult(details: TeachQuizDetails) {
	return {
		content: [{ type: "text" as const, text: details.message ?? "teach_quiz failed." }],
		details,
	};
}

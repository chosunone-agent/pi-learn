/**
 * `teach_ask` — a structured question the teacher puts to the learner.
 *
 * Deliberately NOT named `ask_user_question`. That name belongs to the
 * installed `@juicesharp/rpiv-ask-user-question`, which registers up to four
 * tabbed questions with previews, notes, and a submit tab. Two extensions
 * registering one tool name is a hard load failure in pi, and more importantly
 * the two tools model different things:
 *
 *   ask_user_question  — "which of these do you want?" (planning a task)
 *   teach_ask          — "where does your understanding currently sit?"
 *
 * `teach_ask` therefore carries teaching-specific fields, all optional so a
 * plain multiple-choice question stays a one-liner:
 *
 *   - `kind` labels the pedagogical intent (diagnostic, preference, checkpoint,
 *     clarification) so the log and the teacher can distinguish a probe from a
 *     real fork in the lesson.
 *   - `expectation` states what the teacher predicts the learner will answer,
 *     which turns a wrong answer into information about the *teaching*, not
 *     just about the learner.
 *   - `allowCustom` and `allowUnsure` are explicit. A diagnostic question is
 *     only honest if "I don't know" is always reachable, so `allowUnsure`
 *     defaults to true for diagnostic questions and the runtime guarantees the
 *     row is present for them.
 *
 * The result is a structured record, not prose, so `md-log` can render it and
 * the teacher can reason over answers without re-parsing a sentence.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { openChoice, type ChoiceOption, type ChoiceResult } from "../lib/choice-view.ts";
import { normalizeOptions, validateOptions } from "../lib/question-schema.ts";
import { registerInteractiveToolReconciler } from "../lib/reconcile-tools.ts";
import { withUiLock } from "../lib/ui-lock.ts";

type AskKind = "diagnostic" | "preference" | "checkpoint" | "clarification";
type AskStatus = "answered" | "cancelled" | "unavailable";

export interface TeachAskAnswer {
	/** 1-based position in the displayed option list; 0 for rows that are not options. */
	index: number;
	label: string;
	value: string;
	description?: string;
}

export interface TeachAskDetails {
	status: AskStatus;
	kind: AskKind;
	question: string;
	context?: string;
	multiSelect: boolean;
	answers: TeachAskAnswer[];
	customText?: string;
	unsure?: boolean;
	note?: string;
	expectation?: string;
	options: Array<{ index: number; label: string; value: string }>;
	message?: string;
}

const UNSure_ID = "unsure";
const CUSTOM_LABEL = "Type something.";

const OptionSchema = Type.Object({
	label: Type.String({
		description: 'Short option label (1-5 words). Put a recommended option first and append "(Recommended)".',
	}),
	value: Type.Optional(
		Type.String({ description: "Stable machine-readable value. Defaults to the label. Use stable values, not positions." }),
	),
	description: Type.Optional(Type.String({ description: "One line on what this choice means or costs the learner." })),
});

const TeachAskParams = Type.Object({
	question: Type.String({ description: "The single question to ask. Ask exactly one question per tool call." }),
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("diagnostic"),
				Type.Literal("preference"),
				Type.Literal("checkpoint"),
				Type.Literal("clarification"),
			],
			{
				description:
					"Pedagogical intent. 'diagnostic' probes prior knowledge before teaching; 'checkpoint' checks the learner followed a step just taught; 'preference' lets them choose a direction; 'clarification' resolves an ambiguity that blocks progress. Defaults to 'clarification'.",
			},
		),
	),
	context: Type.Optional(Type.String({ description: "Optional context shown under the question." })),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description:
				"Authored choices. Omit or pass an empty array for a pure free-text question. Do not author 'Type something.' or 'I don't know'; the runtime appends those.",
		}),
	),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow and require more than one selection." })),
	allowCustom: Type.Optional(
		Type.Boolean({
			description: "Append a free-text row. Defaults to true whenever options are given.",
		}),
	),
	allowUnsure: Type.Optional(
		Type.Boolean({
			description:
				"Append an 'I don't know' row that is recorded as a distinct signal, never as a wrong option. Defaults to true for 'diagnostic' and 'checkpoint' questions, false otherwise.",
		}),
	),
	expectation: Type.Optional(
		Type.String({
			description:
				"What the teacher predicts the learner will answer. Recorded with the result so a surprising answer is legible as a teaching signal. Not shown to the learner.",
		}),
	),
});

function resolveKind(raw: string | undefined): AskKind {
	switch (raw) {
		case "diagnostic":
		case "preference":
		case "checkpoint":
		case "clarification":
			return raw;
		default:
			return "clarification";
	}
}

function defaultAllowUnsure(kind: AskKind): boolean {
	return kind === "diagnostic" || kind === "checkpoint";
}

function toAnswers(result: ChoiceResult, options: ChoiceOption[]): TeachAskAnswer[] {
	const byValue = new Map(options.map((option, index) => [option.value, index + 1]));
	return result.selections.map((selection) => ({
		index: byValue.get(selection.value) ?? 0,
		label: selection.label,
		value: selection.value,
		description: selection.description,
	}));
}

function envelope(details: TeachAskDetails): string {
	if (details.status === "cancelled") return "User declined to answer.";
	if (details.status === "unavailable") return details.message ?? "Question could not be shown.";
	const parts: string[] = [];
	for (const answer of details.answers) parts.push(`${answer.index}. ${answer.label}`);
	if (details.customText) parts.push(`own words: ${details.customText}`);
	if (details.unsure) parts.push("answered: I don't know");
	if (details.note) parts.push(`note: ${details.note}`);
	const body = parts.length > 0 ? parts.join("; ") : "no answer given";
	return `${details.kind} answer — ${body}`;
}

function buildDetails(
	status: AskStatus,
	params: { question: string; context?: string; expectation?: string },
	kind: AskKind,
	multiSelect: boolean,
	options: ChoiceOption[],
	result?: ChoiceResult,
	message?: string,
): TeachAskDetails {
	return {
		status,
		kind,
		question: params.question,
		context: params.context,
		expectation: params.expectation,
		multiSelect,
		answers: result ? toAnswers(result, options) : [],
		customText: result?.customText,
		unsure: result?.extraId === UNSure_ID ? true : undefined,
		note: result?.note,
		options: options.map((option, index) => ({ index: index + 1, label: option.label, value: option.value })),
		message,
	};
}

export default function teachAsk(pi: ExtensionAPI) {
	// Keep the tool out of the model's list when there is no UI to render it in.
	registerInteractiveToolReconciler(pi, ["teach_ask"]);

	pi.registerTool({
		name: "teach_ask",
		label: "Teach: ask",
		description:
			"Ask the learner one structured question and wait for the answer. Use it when the next teaching move depends on what the learner already knows or wants, rather than on a guess: to probe prior knowledge before explaining, to check understanding after a step, to let them choose a direction, or to resolve an ambiguity that blocks progress. Prefer it over assuming. One question per call; make several calls instead of bundling unrelated questions. Answer options are authored choices; the runtime appends a free-text row and, for diagnostic and checkpoint questions, an 'I don't know' row that is recorded as a distinct signal rather than a wrong answer.",
		promptSnippet:
			"Ask the learner one structured question (diagnostic probe, checkpoint, preference, or clarification) and wait for the answer.",
		promptGuidelines: [
			"Ask exactly one question per tool call; make multiple calls rather than bundling.",
			"Use kind='diagnostic' before teaching something new, kind='checkpoint' right after teaching a step, kind='preference' when the learner should steer, kind='clarification' when an ambiguity blocks progress.",
			"Do not author 'Type something.', 'I don't know', 'Other', or 'Submit' as option labels; the runtime appends those.",
			"Give 2-4 options, each with a one-line description of what it means or costs.",
			"Set expectation to what you predict the learner will answer; a mismatch is a signal about your teaching, not just their knowledge.",
			"An honest 'I don't know' is never a wrong answer; keep allowUnsure on for diagnostic and checkpoint questions.",
		],
		parameters: TeachAskParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const kind = resolveKind(params.kind);
			const question = params.question.trim();
			const context = params.context?.trim() || undefined;
			const expectation = params.expectation?.trim() || undefined;
			const multiSelect = params.multiSelect === true;
			const options = normalizeOptions(params.options);

			const validation = validateOptions(options, 0);
			if (!validation.ok) {
				return errorResult(
					buildDetails("cancelled", { question, context, expectation }, kind, multiSelect, options, undefined, validation.message),
				);
			}
			if (multiSelect && options.length === 0) {
				return errorResult(
					buildDetails("cancelled", { question, context, expectation }, kind, multiSelect, options, undefined,
						"multiSelect requires at least one authored option."),
				);
			}
			if (signal?.aborted) {
				return cancelledResult(buildDetails("cancelled", { question, context, expectation }, kind, multiSelect, options));
			}
			if (!ctx.hasUI) {
				return errorResult(
					buildDetails("unavailable", { question, context, expectation }, kind, multiSelect, options, undefined,
						"teach_ask needs an interactive terminal."),
				);
			}

			const allowUnsure = params.allowUnsure ?? (options.length > 0 && defaultAllowUnsure(kind));
			const allowCustom = params.allowCustom ?? options.length > 0;

			if (options.length === 0) {
				// Pure free-text: reuse pi's editor via the same component, with no
				// option rows, so every answer path renders identically.
				const result = await withUiLock(() =>
					openChoice(ctx, {
						title: question,
						context,
						options: [],
						multiSelect: false,
						customAnswerLabel: "Type your answer.",
					}),
				);
				if (!result) {
					return cancelledResult(buildDetails("cancelled", { question, context, expectation }, kind, multiSelect, options));
				}
				const details = buildDetails("answered", { question, context, expectation }, kind, multiSelect, options, {
					selections: [],
					customText: result.customText,
					note: result.note,
				});
				return successResult(details);
			}

			const result = await withUiLock(() =>
				openChoice(ctx, {
					title: question,
					context,
					options,
					multiSelect,
					customAnswerLabel: allowCustom ? CUSTOM_LABEL : undefined,
					extraRows: allowUnsure ? [{ id: UNSure_ID, label: "I don't know", hint: "Honest — recorded as a signal, not a wrong answer." }] : [],
					noteEnabled: true,
				}),
			);

			if (!result) {
				return cancelledResult(buildDetails("cancelled", { question, context, expectation }, kind, multiSelect, options));
			}
			const answered = buildDetails("answered", { question, context, expectation }, kind, multiSelect, options, result);
			return successResult(answered);
		},

		renderCall(args, theme) {
			const kind = resolveKind(args.kind);
			const options = normalizeOptions(args.options as never);
			let text = theme.fg("toolTitle", theme.bold("teach_ask ")) + theme.fg("muted", `[${kind}] `) + theme.fg("text", args.question);
			if (options.length > 0) {
				text += `\n${theme.fg("dim", `  Options: ${options.map((o) => o.label).join(", ")}`)}`;
			}
			if (args.expectation) {
				text += `\n${theme.fg("dim", `  Expecting: ${args.expectation}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as TeachAskDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.status === "cancelled") return new Text(theme.fg("warning", "Declined"), 0, 0);
			if (details.status === "unavailable") return new Text(theme.fg("warning", details.message ?? "Unavailable"), 0, 0);

			const lines: string[] = [];
			for (const answer of details.answers) {
				lines.push(`${theme.fg("success", "✓ ")}${theme.fg("accent", `${answer.index}. ${answer.label}`)}`);
			}
			if (details.customText) lines.push(`${theme.fg("success", "✓ ")}${theme.fg("muted", "own words: ")}${theme.fg("accent", details.customText)}`);
			if (details.unsure) lines.push(`${theme.fg("dim", "? I don't know")}`);
			if (details.note) lines.push(`${theme.fg("muted", `note: ${firstLine(details.note)}`)}`);
			return new Text(lines.join("\n") || theme.fg("dim", "(no answer)"), 0, 0);
		},
	});
}

function firstLine(text: string): string {
	const index = text.indexOf("\n");
	return index === -1 ? text : `${text.slice(0, index)}…`;
}

function successResult(details: TeachAskDetails) {
	return {
		content: [{ type: "text" as const, text: envelope(details) }],
		details,
	};
}

function cancelledResult(details: TeachAskDetails) {
	return {
		content: [{ type: "text" as const, text: "User declined to answer." }],
		details,
	};
}

function errorResult(details: TeachAskDetails) {
	return {
		content: [{ type: "text" as const, text: details.message ?? "teach_ask failed." }],
		details,
	};
}

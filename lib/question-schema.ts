/**
 * Shared parameter handling for `teach_ask` and `teach_quiz`.
 *
 * Both tools accept authored options and both must reject labels that collide
 * with rows the runtime appends. Defining that in one place keeps the two tools
 * from drifting apart on the rules that matter for correctness.
 */

/** An authored option after normalization. */
export interface NormalizedOption {
	label: string;
	value: string;
	description?: string;
}

/**
 * Labels the runtime owns.
 *
 * A model that authors "Other" or "I don't know" as an ordinary option creates a
 * duplicate row that looks authoritative but has different semantics — the
 * runtime row is recorded as a distinct signal, not as a choice. Rejecting the
 * label is the only way to keep that distinction intact.
 */
export const RESERVED_LABELS: ReadonlySet<string> = new Set([
	"type something.",
	"type your answer.",
	"i don't know",
	"i dont know",
	"other",
	"submit",
]);

/** Trim, drop label-less entries, and default each value to its label. */
export function normalizeOptions(
	raw: Array<{ label?: string; value?: string; description?: string }> | undefined,
): NormalizedOption[] {
	return (raw ?? [])
		.map((option) => {
			const label = (option.label ?? "").trim();
			const value = (option.value ?? "").trim();
			return {
				label,
				value: value.length > 0 ? value : label,
				description: option.description?.trim() || undefined,
			};
		})
		.filter((option) => option.label.length > 0);
}

/** The first authored label that collides with a runtime row, if any. */
export function findReservedLabel(options: NormalizedOption[]): string | undefined {
	for (const option of options) {
		if (RESERVED_LABELS.has(option.label.toLowerCase())) return option.label;
	}
	return undefined;
}

/**
 * Duplicate labels are rejected because the transcript, the log, and the
 * rendered feedback row are all keyed on the label. Two options with one label
 * produce an unreadable record of what the learner actually chose.
 */
export function findDuplicateLabel(options: NormalizedOption[]): string | undefined {
	const seen = new Set<string>();
	for (const option of options) {
		const key = option.label.toLowerCase();
		if (seen.has(key)) return option.label;
		seen.add(key);
	}
	return undefined;
}

/** Duplicate values are worse than duplicate labels: grading keys on the value. */
export function findDuplicateValue(options: NormalizedOption[]): string | undefined {
	const seen = new Set<string>();
	for (const option of options) {
		if (seen.has(option.value)) return option.value;
		seen.add(option.value);
	}
	return undefined;
}

/**
 * Validate a question's options for both tools.
 *
 * `minimum` differs: ask allows a pure free-text question (zero options), quiz
 * always needs at least two gradeable options.
 */
export function validateOptions(
	options: NormalizedOption[],
	minimum: number,
): { ok: true } | { ok: false; message: string } {
	if (options.length < minimum) {
		return { ok: false, message: `needs at least ${minimum} authored option(s); got ${options.length}.` };
	}
	const reserved = findReservedLabel(options);
	if (reserved) {
		return {
			ok: false,
			message: `Option label "${reserved}" is reserved — the runtime appends that row itself. Choose a different label.`,
		};
	}
	const duplicateLabel = findDuplicateLabel(options);
	if (duplicateLabel) {
		return { ok: false, message: `Two options share the label "${duplicateLabel}"; labels must be distinct.` };
	}
	const duplicateValue = findDuplicateValue(options);
	if (duplicateValue) {
		return {
			ok: false,
			message: `Two options share the value "${duplicateValue}"; values must be distinct because grading keys on them.`,
		};
	}
	return { ok: true };
}

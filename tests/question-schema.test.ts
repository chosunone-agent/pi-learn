import assert from "node:assert/strict";
import test from "node:test";
import { findDuplicateLabel, findDuplicateValue, findReservedLabel, normalizeOptions, validateOptions } from "../lib/question-schema.ts";

test("normalizeOptions defaults each value to its label", () => {
	const options = normalizeOptions([{ label: "Mercury" }]);
	assert.deepEqual(options, [{ label: "Mercury", value: "Mercury", description: undefined }]);
});

test("normalizeOptions keeps an explicit value distinct from its label", () => {
	// The value is the grading key; a mismatch between label and value is
	// legitimate (a translated or renamed option with a stable id).
	const options = normalizeOptions([{ label: "The third planet", value: "earth" }]);
	assert.equal(options[0]?.value, "earth");
	assert.equal(options[0]?.label, "The third planet");
});

test("normalizeOptions drops label-less entries and trims", () => {
	const options = normalizeOptions([
		{ label: "  Mercury  " },
		{ label: "   " },
		{ value: "orphan" },
	]);
	assert.deepEqual(options.map((option) => option.label), ["Mercury"]);
});

test("normalizeOptions treats an empty-string value as absent", () => {
	// An empty value would collide with every other empty value in grading.
	const options = normalizeOptions([{ label: "Mercury", value: "   " }]);
	assert.equal(options[0]?.value, "Mercury");
});

test("normalizeOptions handles undefined input", () => {
	assert.deepEqual(normalizeOptions(undefined), []);
});

test("reserved labels are rejected case- and whitespace-insensitively", () => {
	for (const label of ["Other", "OTHER", "other", "I don't know", "i dont know", "Type something.", "Submit"]) {
		const options = normalizeOptions([{ label }]);
		assert.equal(findReservedLabel(options), label, `${label} should be reserved`);
	}
});

test("a legitimate label that merely contains a reserved word is allowed", () => {
	// Over-blocking would make the rule annoying enough to work around.
	for (const label of ["Other options below", "Submission cost", "I don't know yet, but I can derive it"]) {
		const options = normalizeOptions([{ label }]);
		assert.equal(findReservedLabel(options), undefined, `${label} should be allowed`);
	}
});

test("duplicate labels are detected case-insensitively", () => {
	assert.equal(findDuplicateLabel(normalizeOptions([{ label: "Earth" }, { label: "earth" }])), "earth");
	assert.equal(findDuplicateLabel(normalizeOptions([{ label: "Earth" }, { label: "Mars" }])), undefined);
});

test("duplicate values are detected even when labels differ", () => {
	// This is the failure that silently makes grading ambiguous: two options hash
	// to one value, so picking either grades the same.
	assert.equal(findDuplicateValue(normalizeOptions([{ label: "A", value: "x" }, { label: "B", value: "x" }])), "x");
});

test("validateOptions allows a zero-option ask but rejects a zero-option quiz", () => {
	assert.equal(validateOptions(normalizeOptions([]), 0).ok, true);
	const quiz = validateOptions(normalizeOptions([{ label: "only" }]), 2);
	assert.equal(quiz.ok, false);
	assert.match(quiz.ok === false ? quiz.message : "", /at least 2/);
});

test("validateOptions rejection messages name the offending label or value", () => {
	const reserved = validateOptions(normalizeOptions([{ label: "Other" }, { label: "Mars" }]), 2);
	assert.equal(reserved.ok, false);
	assert.match(reserved.ok === false ? reserved.message : "", /"Other" is reserved/);

	const duplicates = validateOptions(normalizeOptions([{ label: "A", value: "dup" }, { label: "B", value: "dup" }]), 2);
	assert.equal(duplicates.ok, false);
	assert.match(duplicates.ok === false ? duplicates.message : "", /"dup"/);
});

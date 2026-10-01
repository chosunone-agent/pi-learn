import assert from "node:assert/strict";
import test from "node:test";
import { applyEdit, snippetAround } from "../lib/figures.ts";
import { withUiLock } from "../lib/ui-lock.ts";

// ── applyEdit: pi's edit contract, deliberately stricter ────────────────────

test("applyEdit replaces a unique occurrence", () => {
	const { updated, index } = applyEdit("A -> B\nB -> C\n", "B -> C", "B -> D");
	assert.equal(updated, "A -> B\nB -> D\n");
	assert.equal(index, 7);
});

test("applyEdit refuses an ambiguous match instead of guessing", () => {
	// Guessing which of two matches to replace would silently corrupt a figure.
	assert.throws(() => applyEdit("x = 1\ny = 1\n", "1", "2"), /matches 2 times/);
});

test("applyEdit reports a missing match rather than silently doing nothing", () => {
	assert.throws(() => applyEdit("abc", "zzz", "y"), /not found/);
});

test("applyEdit rejects an empty target", () => {
	// An empty old_text matches everywhere; treating it as "insert at 0" would
	// make an accidental empty argument destroy the file's structure.
	assert.throws(() => applyEdit("abc", "", "x"), /must not be empty/);
});

test("applyEdit is stricter than pi's edit: overlapping matches are still ambiguous", () => {
	// pi's edit counts non-overlapping occurrences only (`split().length - 1`),
	// so it would accept "aa" in "aaa" and replace the first match. For a figure
	// that is a silent, plausible-looking corruption, so refusing is deliberate.
	assert.throws(() => applyEdit("aaa", "aa", "b"), /matches 2 times/);
	assert.throws(() => applyEdit("aaa", "aa", "b"), /overlap/);
});

test("applyEdit reports the offsets it found, which is what makes a fix actionable", () => {
	assert.throws(() => applyEdit("abcabc", "abc", "x"), /0, 3/);
});

test("applyEdit accepts a repeated target once context makes it unique", () => {
	// The realistic fix a model should reach for: widen the target.
	const source = 'A -> B [label="x"]\nA -> B [label="y"]';
	const { updated } = applyEdit(source, 'A -> B [label="y"]', 'A -> C [label="y"]');
	assert.ok(updated.includes('A -> B [label="x"]'), "the other edge must be untouched");
	assert.ok(updated.includes('A -> C [label="y"]'));
});

test("applyEdit can be used twice in a row, converging like a real edit loop", () => {
	const first = applyEdit("graph TD\nA-->B\n", "A-->B", "A-->B\nB-->C");
	const second = applyEdit(first.updated, "A-->B", "A-->X");
	assert.equal(second.updated, "graph TD\nA-->X\nB-->C\n");
});

test("snippetAround marks truncation only when it truncates", () => {
	const text = "0123456789";
	assert.equal(snippetAround(text, 5, 100), text, "a full window needs no ellipsis");
	const wide = snippetAround("x".repeat(1000), 500, 10);
	assert.ok(wide.startsWith("…"));
	assert.ok(wide.endsWith("…"));
});

// ── withUiLock: serialization and failure isolation ────────────────────────

test("withUiLock serializes overlapping calls", async () => {
	const order: string[] = [];
	let resolveFirst!: () => void;
	const gate = new Promise<void>((resolve) => {
		resolveFirst = resolve;
	});

	const first = withUiLock(async () => {
		order.push("first:start");
		await gate;
		order.push("first:end");
	});
	const second = withUiLock(async () => {
		order.push("second:start");
		order.push("second:end");
	});

	resolveFirst();
	await Promise.all([first, second]);
	assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("withUiLock returns each call's own value", async () => {
	const [a, b] = await Promise.all([withUiLock(async () => 1), withUiLock(async () => "two")]);
	assert.equal(a, 1);
	assert.equal(b, "two");
});

test("a throwing call does not poison the queue for later callers", async () => {
	// A rejected pop-up (user cancels, UI errors) must not wedge every future
	// question in the session.
	await assert.rejects(
		withUiLock(async () => {
			throw new Error("boom");
		}),
		/boom/,
	);
	const after = await withUiLock(async () => "still works");
	assert.equal(after, "still works");
});

test("withUiLock recovers even when a rejected call was not awaited", async () => {
	const failing = withUiLock(async () => {
		throw new Error("unobserved");
	});
	failing.catch(() => {});
	const result = await withUiLock(async () => "ok");
	assert.equal(result, "ok");
});

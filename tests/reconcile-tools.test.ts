import assert from "node:assert/strict";
import test from "node:test";
import { reconcileInteractiveTools } from "../lib/reconcile-tools.ts";

/** A fake ExtensionAPI tracking the active tool set. */
function fakePi(initial: string[]) {
	let active = [...initial];
	return {
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
		get active() {
			return [...active];
		},
	} as never as {
		getActiveTools(): string[];
		setActiveTools(names: string[]): void;
		active: string[];
	};
}

const TOOLS = ["teach_ask", "teach_quiz"] as const;

test("tools are stripped when there is no UI", () => {
	// A model that sees an unusable tool burns a call discovering that, and the
	// failure only surfaces in the tool result.
	const pi = fakePi([...TOOLS, "read", "bash"]);
	reconcileInteractiveTools(pi as never, { hasUI: false } as never, TOOLS);
	assert.deepEqual(pi.active, ["read", "bash"]);
});

test("tools are restored when a UI is present", () => {
	const pi = fakePi(["read", "bash"]);
	reconcileInteractiveTools(pi as never, { hasUI: true } as never, TOOLS);
	assert.deepEqual(pi.active.sort(), ["bash", "read", "teach_ask", "teach_quiz"]);
});

test("other tools, including the user's selection, are never disturbed", () => {
	// Only our own names may be added or removed; clobbering `--tools` would be a
	// far worse bug than the one being fixed.
	const pi = fakePi(["read", "sudo_run", "ask_user_question"]);
	reconcileInteractiveTools(pi as never, { hasUI: true } as never, TOOLS);
	assert.ok(pi.active.includes("sudo_run"), "unrelated tool was dropped");
	assert.ok(pi.active.includes("ask_user_question"), "another extension's tool was dropped");
	assert.ok(pi.active.includes("read"));

	reconcileInteractiveTools(pi as never, { hasUI: false } as never, TOOLS);
	assert.deepEqual(pi.active, ["read", "sudo_run", "ask_user_question"]);
});

test("reconciling is idempotent", () => {
	const pi = fakePi(["read"]);
	reconcileInteractiveTools(pi as never, { hasUI: true } as never, TOOLS);
	const once = [...pi.active];
	reconcileInteractiveTools(pi as never, { hasUI: true } as never, TOOLS);
	assert.deepEqual(pi.active, once, "a second pass must not duplicate entries");

	reconcileInteractiveTools(pi as never, { hasUI: false } as never, TOOLS);
	const stripped = [...pi.active];
	reconcileInteractiveTools(pi as never, { hasUI: false } as never, TOOLS);
	assert.deepEqual(pi.active, stripped);
});

test("a partial restore adds only what is missing, without reordering", () => {
	const pi = fakePi(["teach_ask", "read"]);
	reconcileInteractiveTools(pi as never, { hasUI: true } as never, TOOLS);
	assert.deepEqual(pi.active, ["teach_ask", "read", "teach_quiz"]);
});

test("it does not add tools that were never registered", () => {
	// Restoring a name pi never registered would produce an unknown-tool error.
	const pi = fakePi(["read"]);
	reconcileInteractiveTools(pi as never, { hasUI: true } as never, ["teach_ask", "teach_quiz"]);
	assert.equal(pi.active.filter((n) => n === "teach_quiz").length, 1);
});

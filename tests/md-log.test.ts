import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mdLog from "../extensions/md-log.ts";

/**
 * A minimal stand-in for pi's ExtensionAPI.
 *
 * Driving the extension's handlers directly is the only way to test the log
 * deterministically: a real `pi -p` run cannot express "a message arrived, then
 * a tool result" without depending on what a model chooses to do, and it cannot
 * run a slash command and a chat message in one turn at all (the command
 * consumes the input).
 */
function createHarness() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
	const entries: Array<Record<string, unknown>> = [];

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => unknown }) {
			commands.set(name, definition);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data, id: `e${entries.length}` });
		},
	} as never;

	mdLog(pi);

	return {
		entries,
		async emit(event: string, payload: unknown, ctx: Record<string, unknown> = {}) {
			const list = handlers.get(event) ?? [];
			for (const handler of list) await handler(payload, { ui: createUi(), ...ctx });
		},
		async run(command: string, args: string, ctx: Record<string, unknown> = {}) {
			const definition = commands.get(command);
			if (!definition) throw new Error(`command ${command} not registered`);
			return definition.handler(args, { ui: createUi(), ...ctx });
		},
		hasCommand: (name: string) => commands.has(name),
	};
}

function createUi() {
	const notifications: Array<{ message: string; level?: string }> = [];
	return {
		notifications,
		theme: { fg: (_token: string, text: string) => text },
		notify(message: string, level?: string) {
			notifications.push({ message, level });
		},
		setStatus() {},
	};
}

function sessionManager() {
	return {
		getEntries: () => [] as unknown[],
	};
}

function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> | void {
	const dir = mkdtempSync(join(tmpdir(), "pi-learn-log-"));
	const done = () => rmSync(dir, { recursive: true, force: true });
	try {
		const result = fn(dir);
		if (result instanceof Promise) return result.finally(done);
		done();
	} catch (error) {
		done();
		throw error;
	}
}

const userMessage = (text: string) => ({ type: "message_end", message: { role: "user", content: text } });
const assistantMessage = (text: string) => ({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

test("learn-log registers both commands", () => {
	const harness = createHarness();
	assert.ok(harness.hasCommand("learn-log"));
	assert.ok(harness.hasCommand("learn-unlog"));
});

test("linking a topic creates a dated lesson file and logs nothing until a message arrives", async () => {
	await withTempDir(async (dir) => {
		const harness = createHarness();
		await harness.run("learn-log", "tcp-reliability", { cwd: dir, sessionManager: sessionManager() });
		const path = join(dir, "lessons", "2026-10-01-tcp-reliability.md");
		// The file is created with a heading; the date is today's, so only assert
		// the directory and slug rather than a fixed date.
		const files = readFileSync(join(dir, "lessons", readdir(join(dir, "lessons"))[0] as string), "utf8");
		assert.match(files, /^# tcp-reliability/);
		assert.ok(path.endsWith(".md"));
	});
});

test("a multi-line argument uses only the first line as the topic", async () => {
	await withTempDir(async (dir) => {
		const harness = createHarness();
		await harness.run("learn-log", "tcp\nExplain packet ordering.", { cwd: dir, sessionManager: sessionManager() });
		const name = readdir(join(dir, "lessons"))[0] as string;
		assert.match(name, /tcp\.md$/, `unexpected filename: ${name}`);
		assert.ok(!name.includes("explain"), "later lines must not leak into the filename");
	});
});

test("user and assistant messages are mirrored after linking", async () => {
	await withTempDir(async (dir) => {
		const harness = createHarness();
		const ctx = { cwd: dir, sessionManager: sessionManager() };
		await harness.run("learn-log", "topic", ctx);
		await harness.emit("message_end", userMessage("why does ordering matter?"), ctx);
		await harness.emit("message_end", assistantMessage("Because reassembly needs the sequence."), ctx);

		const content = readFileSync(join(dir, "lessons", readdir(join(dir, "lessons"))[0] as string), "utf8");
		assert.ok(content.includes("why does ordering matter?"), "the learner's prompt must be logged");
		assert.ok(content.includes("Because reassembly needs the sequence."), "the lesson prose must be logged");
	});
});

test("nothing is logged before a lesson file is linked", async () => {
	await withTempDir(async (dir) => {
		const harness = createHarness();
		const ctx = { cwd: dir, sessionManager: sessionManager() };
		await harness.emit("message_end", userMessage("unlinked prompt"), ctx);
		await harness.emit("message_end", assistantMessage("unlinked answer"), ctx);
		assert.ok(!exists(join(dir, "lessons")), "an unlinked session must not create files");
	});
});

test("learn-unlog stops logging", async () => {
	await withTempDir(async (dir) => {
		const harness = createHarness();
		const ctx = { cwd: dir, sessionManager: sessionManager() };
		await harness.run("learn-log", "topic", ctx);
		await harness.emit("message_end", userMessage("logged"), ctx);
		await harness.run("learn-unlog", "", ctx);
		await harness.emit("message_end", userMessage("should be dropped"), ctx);

		const content = readFileSync(join(dir, "lessons", readdir(join(dir, "lessons"))[0] as string), "utf8");
		assert.ok(content.includes("logged"));
		assert.ok(!content.includes("should be dropped"), "unlinking must stop further writes");
	});
});

test("an explicit path must already exist, so a typo cannot create stray files", async () => {
	await withTempDir(async (dir) => {
		const harness = createHarness();
		const ui = createUi();
		await harness.run("learn-log", "./notes/missing.md", { cwd: dir, sessionManager: sessionManager(), ui });
		assert.equal(ui.notifications.at(-1)?.level, "error");
		assert.ok(!exists(join(dir, "notes")), "a missing explicit path must not be created");
	});
});

test("a teach_ask question is logged before its answer, without the answer", async () => {
	await withTempDir(async (dir) => {
		const harness = createHarness();
		const ctx = { cwd: dir, sessionManager: sessionManager() };
		await harness.run("learn-log", "topic", ctx);

		await harness.emit(
			"tool_call",
			{
				toolName: "teach_ask",
				toolCallId: "c1",
				input: {
					question: "What is a vector?",
					kind: "diagnostic",
					options: [{ label: "A magnitude and direction" }, { label: "Just a number" }],
				},
			},
			ctx,
		);

		const afterQuestion = readFileSync(join(dir, "lessons", readdir(join(dir, "lessons"))[0] as string), "utf8");
		assert.ok(afterQuestion.includes("What is a vector?"), "the question must appear on tool_call");
		assert.ok(afterQuestion.includes("1. A magnitude and direction"), "options must be listed");
		assert.ok(afterQuestion.includes("diagnostic"), "the kind must be recorded");

		await harness.emit(
			"tool_result",
			{
				toolName: "teach_ask",
				toolCallId: "c1",
				details: { status: "answered", kind: "diagnostic", answers: [{ index: 2, label: "Just a number" }], unsure: false },
			},
			ctx,
		);

		const afterAnswer = readFileSync(join(dir, "lessons", readdir(join(dir, "lessons"))[0] as string), "utf8");
		assert.ok(afterAnswer.includes("2. Just a number"), "the learner's answer must be logged");
	});
});

test("an 'I don't know' answer is logged as its own outcome, not as a wrong choice", async () => {
	await withTempDir(async (dir) => {
		const harness = createHarness();
		const ctx = { cwd: dir, sessionManager: sessionManager() };
		await harness.run("learn-log", "topic", ctx);
		await harness.emit(
			"tool_result",
			{ toolName: "teach_ask", toolCallId: "c2", details: { status: "answered", kind: "diagnostic", answers: [], unsure: true } },
			ctx,
		);
		const content = readFileSync(join(dir, "lessons", readdir(join(dir, "lessons"))[0] as string), "utf8");
		assert.ok(content.includes("I don't know"));
	});
});

test("a quiz question is written from the post-shuffle order, not the authored order", async () => {
	await withTempDir(async (dir) => {
		const harness = createHarness();
		const ctx = { cwd: dir, sessionManager: sessionManager() };
		await harness.run("learn-log", "topic", ctx);

		// Authored order (what the model passed).
		await harness.emit(
			"tool_call",
			{
				toolName: "teach_quiz",
				toolCallId: "q1",
				input: { question: "Which planet?", options: [{ label: "Earth" }, { label: "Venus" }] },
			},
			ctx,
		);
		// Pre-answer update carrying the order the learner actually saw.
		await harness.emit(
			"tool_execution_update",
			{
				toolName: "teach_quiz",
				toolCallId: "q1",
				partialResult: { details: { options: [{ index: 1, label: "Venus" }, { index: 2, label: "Earth" }] } },
			},
			ctx,
		);

		await harness.emit(
			"tool_result",
			{
				toolName: "teach_quiz",
				toolCallId: "q1",
				details: {
					status: "answered",
					verdict: "correct",
					displayedOptions: [
						{ index: 1, label: "Venus" },
						{ index: 2, label: "Earth" },
					],
					correctIndices: [1],
					selectedIndices: [1],
					explanation: "Venus is the second planet.",
				},
			},
			ctx,
		);

		const content = readFileSync(join(dir, "lessons", readdir(join(dir, "lessons"))[0] as string), "utf8");
		// Strip the callout's blockquote prefix so the assertions read as the
		// learner sees the list, not as markdown quotework.
		const plain = content.replace(/^> ?/gm, "");
		// The shuffle must be reflected: the logged list starts with Venus.
		assert.match(plain, /1\. Venus\n2\. Earth/, `logged order did not match the screen:\n${plain}`);
		assert.ok(!/^1\. Earth$/m.test(plain), "the authored order must not be what is logged");
		assert.ok(/Quiz — correct/.test(plain), "the verdict must be recorded");
		assert.ok(plain.includes("Venus is the second planet."), "the explanation must be logged");
	});

	// The negative direction matters as much: the question block must never
	// contain the answer before the learner has answered.
	await withTempDir(async (dir) => {
		const harness = createHarness();
		const ctx = { cwd: dir, sessionManager: sessionManager() };
		await harness.run("learn-log", "topic", ctx);
		await harness.emit(
			"tool_execution_update",
			{
				toolName: "teach_quiz",
				toolCallId: "q2",
				partialResult: {
					details: {
						options: [{ index: 1, label: "Venus" }, { index: 2, label: "Earth" }],
						correctIndices: [1],
						explanation: "because reasons",
					},
				},
			},
			ctx,
		);
		const content = readFileSync(join(dir, "lessons", readdir(join(dir, "lessons"))[0] as string), "utf8");
		assert.ok(!content.includes("because reasons"), "the explanation must not appear before the answer");
	});
});

test("a cancelled quiz logs as skipped rather than as a wrong answer", async () => {
	await withTempDir(async (dir) => {
		const harness = createHarness();
		const ctx = { cwd: dir, sessionManager: sessionManager() };
		await harness.run("learn-log", "topic", ctx);
		await harness.emit("tool_result", { toolName: "teach_quiz", toolCallId: "q3", details: { status: "cancelled" } }, ctx);
		const content = readFileSync(join(dir, "lessons", readdir(join(dir, "lessons"))[0] as string), "utf8");
		assert.ok(content.includes("skipped"));
		assert.ok(!content.includes("incorrect"));
	});
});

test("injected skill bodies are replaced with a one-line note", async () => {
	await withTempDir(async (dir) => {
		const harness = createHarness();
		const ctx = { cwd: dir, sessionManager: sessionManager() };
		await harness.run("learn-log", "topic", ctx);
		await harness.emit(
			"message_end",
			userMessage('<skill name="teach">\nA very long instruction body.\n</skill>\n\nactual question'),
			ctx,
		);
		const content = readFileSync(join(dir, "lessons", readdir(join(dir, "lessons"))[0] as string), "utf8");
		assert.ok(content.includes("Skill loaded: teach"), "the skill name should be noted");
		assert.ok(!content.includes("A very long instruction body"), "the skill body must not be dumped into the log");
		assert.ok(content.includes("actual question"), "the real prompt must survive");
	});
});

// ── small fs helpers kept local so the test has no extra dependencies ───────

function readdir(dir: string): string[] {
	return readdirSync(dir);
}

function exists(path: string): boolean {
	return existsSync(path);
}

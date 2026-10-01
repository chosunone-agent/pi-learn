/**
 * `md-log` — mirror a teaching session into a readable markdown file.
 *
 * Long teaching sessions are hard to read in a terminal: markdown, math, and
 * code do not render, and scrolling back is painful. This links the session to
 * a `.md` file that renders properly in Obsidian, GitHub, or any markdown
 * viewer, so the lesson survives the session.
 *
 * What it captures is deliberately narrow: the learner's prompts, the
 * assistant's prose (the lesson), and question/quiz exchanges. Tool churn is
 * dropped — a log full of `read` results is not a lesson.
 *
 * Two behaviours worth knowing:
 *
 *   - Questions are written BEFORE the answer, on `tool_call`, so the log reads
 *     as a live transcript and its question blocks never contain the answer or
 *     the explanation (the learner may be reading the file while answering).
 *   - For quizzes, the option order comes from the tool's pre-answer update, not
 *     from its arguments: quizzes shuffle, so the arguments are the authored
 *     order and would not match the screen. Recording the wrong order would
 *     make every graded entry in the log wrong.
 *
 * Commands:
 *   /learn-log <topic|path>   Link a markdown file (backfills this session).
 *   /learn-unlog              Stop logging.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { lessonsDir, looksLikeTopic, resolveLessonPath } from "../lib/paths.ts";

/** Tools whose question/answer pairs belong in the lesson log. */
const QA_TOOLS = new Set(["teach_ask", "teach_quiz"]);

const STATUS_KEY = "md-log";

export default function mdLog(pi: ExtensionAPI) {
	let logFile: string | null = null;
	/** Tool-call id → args, for pairing a question block with its answer block. */
	const pendingCalls = new Map<string, { name: string; args: Record<string, unknown> }>();
	/** Quiz call ids whose question block has already been written from the live update. */
	const loggedQuestion = new Set<string>();

	// ── serialized appends ───────────────────────────────────────────────────
	let writeChain: Promise<void> = Promise.resolve();
	function withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
		const previous = writeChain;
		let release!: () => void;
		writeChain = new Promise<void>((resolve) => {
			release = resolve;
		});
		return previous.then(fn).finally(() => release());
	}

	function append(text: string): void {
		if (!logFile) return;
		try {
			const current = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
			const separator = current.trim().length > 0 ? "\n\n" : "";
			fs.writeFileSync(logFile, `${current}${separator}${text}\n`, "utf8");
		} catch {
			// The file may have been moved or deleted underneath us; a log failure
			// must never break the teaching session.
		}
	}

	// ── markdown formatting ─────────────────────────────────────────────────

	function callout(kind: string, title: string, body: string[]): string {
		const lines = [`> [!${kind}] ${title}`];
		for (const line of body) lines.push(line.length === 0 ? ">" : `> ${line}`);
		return lines.join("\n");
	}

	function userBlock(text: string): string {
		return `> [!quote] YOU\n\n${text}`;
	}

	function assistantBlock(text: string): string {
		return `> [!abstract] PI\n\n${text}`;
	}

	/**
	 * Replace injected skill bodies with a one-line note.
	 *
	 * When a skill loads, pi injects the whole `SKILL.md` into the user turn.
	 * That is system context, not something the learner typed, and pasting a
	 * page of instructions into the log buries the actual conversation.
	 */
	function stripSkillBlocks(text: string): string {
		return text.replace(/<skill\b([^>]*)>[\s\S]*?<\/skill>/g, (_match, attrs: string) => {
			const name = /name="([^"]+)"/.exec(attrs)?.[1];
			return `> [!note] Skill loaded: ${name ?? "(unknown)"}`;
		});
	}

	function textFromContent(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text as string)
			.join("\n");
	}

	function optionsList(options: Array<{ label?: string }>): string[] {
		return options.map((option, index) => `${index + 1}. ${option.label ?? ""}`);
	}

	function questionBlock(label: string, question: string, context: string | undefined, options: Array<{ label?: string }>): string {
		const body: string[] = [];
		for (const line of question.split("\n")) body.push(line);
		if (context) {
			body.push("");
			for (const line of context.split("\n")) body.push(line);
		}
		if (options.length > 0) {
			body.push("");
			body.push(...optionsList(options));
		}
		return callout("question", label, body);
	}

	function askAnswerBlock(details: Record<string, unknown> | undefined): string {
		const status = details?.status;
		if (status === "cancelled") return callout("warning", "Question — declined", ["(no answer given)"]);
		if (status === "unavailable") return callout("warning", "Question — unavailable", [String(details?.message ?? "")]);

		const body: string[] = [];
		const answers = (details?.answers as Array<{ index: number; label: string }> | undefined) ?? [];
		for (const answer of answers) body.push(`${answer.index}. ${answer.label}`);
		if (details?.customText) body.push(`Own words: ${String(details.customText)}`);
		if (details?.unsure) body.push("I don't know");
		if (details?.note) body.push("", `Note: ${String(details.note)}`);
		if (body.length === 0) body.push("(no answer)");
		return callout("example", `Answer — ${String(details?.kind ?? "question")}`, body);
	}

	function quizQuestionBlock(details: Record<string, unknown> | undefined): string {
		const question = String(details?.question ?? "");
		const options = (details?.options as Array<{ label?: string }> | undefined) ?? [];
		return questionBlock("Quiz", question, undefined, options);
	}

	function quizAnswerBlock(details: Record<string, unknown> | undefined): string {
		const status = details?.status;
		if (status === "cancelled") return callout("warning", "Quiz — skipped", ["(no answer given)"]);
		if (status === "unavailable") return callout("warning", "Quiz — unavailable", [String(details?.message ?? "")]);

		const verdict = String(details?.verdict ?? "unsure");
		const kind = verdict === "correct" ? "success" : verdict === "incorrect" ? "failure" : "question";
		const title = verdict === "correct" ? "Quiz — correct ✓" : verdict === "incorrect" ? "Quiz — incorrect ✗" : "Quiz — I don't know";

		const displayed = (details?.displayedOptions as Array<{ index: number; label: string }> | undefined) ?? [];
		const selected = new Set((details?.selectedIndices as number[] | undefined) ?? []);
		const correct = new Set((details?.correctIndices as number[] | undefined) ?? []);

		const body: string[] = [];
		for (const option of displayed) {
			const mark = selected.has(option.index) && correct.has(option.index) ? "✓" : selected.has(option.index) ? "✗" : correct.has(option.index) ? "←correct" : "";
			body.push(`${option.index}. ${option.label} ${mark}`.trimEnd());
		}
		const correctList = [...correct].sort((a, b) => a - b);
		body.push("", `Correct answer: ${correctList.join(", ") || "(none)"}`);
		if (details?.note) body.push("", `Note: ${String(details.note)}`);
		if (details?.explanation) body.push("", ...String(details.explanation).split("\n"));
		return callout(kind, title, body);
	}

	// ── session restoration ─────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		logFile = null;
		pendingCalls.clear();
		loggedQuestion.clear();
		let lastLink: { file: string | null } | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "md-log") {
				lastLink = entry.data as { file: string | null } | undefined;
			}
		}
		if (lastLink?.file) {
			logFile = lastLink.file;
			setStatus(ctx, path.basename(lastLink.file));
		}
	});

	function setStatus(ctx: { ui: { setStatus(key: string, text: string | undefined): void; theme: { fg(token: string, text: string): string } } }, name: string): void {
		const { theme } = ctx.ui;
		ctx.ui.setStatus(STATUS_KEY, `${theme.fg("accent", "lesson ")}${theme.fg("dim", name)}`);
	}

	// ── capture ─────────────────────────────────────────────────────────────

	pi.on("message_end", async (event, _ctx) => {
		if (!logFile) return;
		const message = event.message;
		if (!message || !("role" in message)) return;

		if (message.role === "user") {
			const text = stripSkillBlocks(textFromContent(message.content).trim()).trim();
			if (text) await withWriteLock(() => append(userBlock(text)));
			return;
		}
		if (message.role === "assistant") {
			const text = textFromContent(message.content).trim();
			if (text) await withWriteLock(() => append(assistantBlock(text)));
			return;
		}
		// Tool results are handled by the tool_result event so that question
		// blocks can be written before the answer arrives.
	});

	pi.on("tool_call", async (event, _ctx) => {
		if (!logFile) return;
		const toolName = (event as { toolName?: string }).toolName;
		if (!toolName || !QA_TOOLS.has(toolName)) return;
		const input = ((event as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>;
		pendingCalls.set((event as { toolCallId: string }).toolCallId, { name: toolName, args: input });

		// Quiz shuffles, so its arguments are NOT the order on screen. Wait for
		// the pre-answer update (below) instead of logging a wrong order here.
		if (toolName === "teach_quiz") return;

		const options = Array.isArray(input.options) ? (input.options as Array<{ label?: string }>) : [];
		const block = questionBlock(
			`Question — ${String(input.kind ?? "clarification")}`,
			String(input.question ?? ""),
			typeof input.context === "string" ? input.context : undefined,
			options,
		);
		await withWriteLock(() => append(block));
	});

	pi.on("tool_execution_update", async (event, _ctx) => {
		if (!logFile) return;
		const toolName = (event as { toolName?: string }).toolName;
		if (toolName !== "teach_quiz") return;
		const toolCallId = (event as { toolCallId: string }).toolCallId;
		if (loggedQuestion.has(toolCallId)) return;
		const partial = (event as { partialResult?: { details?: Record<string, unknown> } }).partialResult;
		const options = partial?.details?.options as Array<{ index: number; label: string }> | undefined;
		if (!options || options.length === 0) return;
		loggedQuestion.add(toolCallId);
		const call = pendingCalls.get(toolCallId);
		const question = String(call?.args.question ?? partial?.details?.question ?? "");
		const context = typeof call?.args.context === "string" ? call.args.context : undefined;
		await withWriteLock(() => append(questionBlock("Quiz", question, context, options)));
	});

	pi.on("tool_result", async (event, _ctx) => {
		if (!logFile) return;
		const toolName = (event as { toolName?: string }).toolName;
		if (!toolName || !QA_TOOLS.has(toolName)) return;
		const details = (event as { details?: Record<string, unknown> }).details;
		const block = toolName === "teach_quiz" ? quizAnswerBlock(details) : askAnswerBlock(details);
		await withWriteLock(() => append(block));
		const toolCallId = (event as { toolCallId?: string }).toolCallId;
		if (toolCallId) {
			pendingCalls.delete(toolCallId);
			loggedQuestion.delete(toolCallId);
		}
	});

	// ── commands ────────────────────────────────────────────────────────────

	pi.registerCommand("learn-log", {
		description: "Link a markdown file to this session (/learn-log <topic|path>); backfills the session so far",
		handler: async (args, ctx) => {
			// Only the first line is the argument. Command arguments can arrive with
			// trailing prose on later lines (a scripted `-p`, or a paste); treating
			// the whole blob as a topic produces an unreadable filename and a
			// too-long slug.
			const argument = args.split("\n")[0]?.trim() ?? "";
			if (!argument) {
				ctx.ui.notify("Usage: /learn-log <topic|path>", "warning");
				return;
			}
			const target = resolveLessonPath(ctx.cwd, argument);
			const isTopic = looksLikeTopic(argument);

			// A topic creates its file (with its directory); an explicit path must
			// already exist, so a typo cannot silently scatter files around.
			if (isTopic) {
				fs.mkdirSync(lessonsDir(ctx.cwd), { recursive: true });
				if (!fs.existsSync(target)) {
					fs.writeFileSync(target, `# ${argument.trim()}\n`, "utf8");
				}
			} else if (!fs.existsSync(target)) {
				ctx.ui.notify(`File does not exist: ${target}`, "error");
				return;
			}

			const count = backfill(ctx, target);
			logFile = target;
			pi.appendEntry("md-log", { file: target });
			setStatus(ctx, path.basename(target));
			ctx.ui.notify(`Logging to ${target} (${count} entries backfilled)`, "success");
		},
	});

	pi.registerCommand("learn-unlog", {
		description: "Stop mirroring this session to the linked markdown file",
		handler: async (_args, ctx) => {
			if (!logFile) {
				ctx.ui.notify("No lesson file is linked.", "warning");
				return;
			}
			const name = path.basename(logFile);
			logFile = null;
			pi.appendEntry("md-log", { file: null });
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.notify(`Unlinked ${name}`, "info");
		},
	});

	// ── backfill ────────────────────────────────────────────────────────────

	/** Walk the active branch and write the lesson so far. Returns entries seen. */
	function backfill(ctx: { sessionManager: { getEntries(): unknown[] } }, target: string): number {
		const entries = ctx.sessionManager.getEntries() as Array<Record<string, any>>;
		if (entries.length === 0) return 0;

		const byId = new Map<string, Record<string, any>>();
		for (const entry of entries) if (entry.id) byId.set(entry.id, entry);

		let leaf: Record<string, any> | null = null;
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i].id) {
				leaf = entries[i];
				break;
			}
		}
		if (!leaf) return 0;

		const chain: Array<Record<string, any>> = [];
		const seen = new Set<string>();
		let cursor: Record<string, any> | null = leaf;
		while (cursor?.id && !seen.has(cursor.id)) {
			seen.add(cursor.id);
			chain.push(cursor);
			cursor = cursor.parentId ? byId.get(cursor.parentId) ?? null : null;
		}
		chain.reverse();

		const callArgs = new Map<string, { name: string; args: Record<string, any> }>();
		const blocks: string[] = [];
		let count = 0;

		for (const entry of chain) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (!message || !("role" in message)) continue;
			count++;

			if (message.role === "user") {
				const text = stripSkillBlocks(textFromContent(message.content).trim()).trim();
				if (text) blocks.push(userBlock(text));
				continue;
			}
			if (message.role === "assistant") {
				for (const part of message.content ?? []) {
					if (part?.type === "toolCall" && QA_TOOLS.has(part.name)) {
						callArgs.set(part.id, { name: part.name, args: part.arguments ?? {} });
					}
				}
				const text = textFromContent(message.content).trim();
				if (text) blocks.push(assistantBlock(text));
				continue;
			}
			if (message.role === "toolResult") {
				if (!QA_TOOLS.has(message.toolName)) continue;
				const call = callArgs.get(message.toolCallId);
				if (message.toolName === "teach_quiz") {
					// The persisted result carries the true display order, which is
					// what the learner saw — the call args are the authored order.
					blocks.push(quizQuestionBlock({ question: call?.args.question, options: message.details?.displayedOptions }));
					blocks.push(quizAnswerBlock(message.details));
				} else {
					blocks.push(
						questionBlock(
							`Question — ${String(call?.args.kind ?? "clarification")}`,
							String(call?.args.question ?? ""),
							typeof call?.args.context === "string" ? call.args.context : undefined,
							Array.isArray(call?.args.options) ? call.args.options : [],
						),
					);
					blocks.push(askAnswerBlock(message.details));
				}
			}
		}

		if (blocks.length > 0) {
			try {
				fs.writeFileSync(target, `${blocks.join("\n\n")}\n`, "utf8");
			} catch {
				// ignore
			}
		}
		return count;
	}
}

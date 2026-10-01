/**
 * Rendering and publishing for the figure-authoring tools.
 *
 * Three renderers are supported, because they cover genuinely different
 * pictures rather than being redundant:
 *
 *   mermaid   — structural/relational diagrams with automatic layout
 *               (flows, sequences, state machines, ER, class, trees). The
 *               default when the picture is nodes-and-edges.
 *   graphviz  — same family, but DOT gives explicit control over layout and is
 *               already installed everywhere here; the fallback when mermaid's
 *               auto-layout puts things in the wrong place.
 *   svg       — hand-authored, exact coordinates. The only correct option for
 *               geometry: number lines, vectors, plots, annotated figures.
 *
 * Everything in this file is free of pi imports so it can be unit tested under
 * `node --test`.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { figureFilename, slugify, uniquePath, vizDir } from "./paths.ts";

/** Where transient source and preview files live. Never inside the project. */
export const STAGING_ROOT = join(tmpdir(), "pi-learn-figures");

/**
 * Chrome candidates, checked in order.
 *
 * The reference implementation listed only macOS bundles, so on Linux it always
 * fell through to puppeteer's bundled browser — which works only if puppeteer's
 * install step was allowed to download it. These paths are checked first on
 * Linux, which removes that hidden dependency.
 */
export const CHROME_CANDIDATES = [
	"/usr/bin/google-chrome-stable",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/opt/google/chrome/chrome",
	"/snap/bin/chromium",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/** Directories that are commonly outside a minimal PATH. */
export const EXTRA_PATH_DIRS = ["/opt/local/bin", "/usr/local/bin", "/opt/homebrew/bin", "/snap/bin"];

export function findChrome(): string | undefined {
	for (const candidate of CHROME_CANDIDATES) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** Run a command, capturing output, with a hard kill on timeout. */
export function run(
	command: string,
	args: string[],
	options: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<RunResult> {
	return new Promise((resolve) => {
		const path = [...EXTRA_PATH_DIRS, process.env.PATH ?? ""].join(":");
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: { ...process.env, ...(options.env ?? {}), PATH: path },
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: null, stdout, stderr: `${stderr}${String(error)}`, timedOut });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}

/** Which renderers are usable here, and why not when they are not. */
export interface RendererStatus {
	available: boolean;
	detail: string;
}

export async function rendererAvailability(packageRoot: string): Promise<Record<"mermaid" | "graphviz" | "svg", RendererStatus>> {
	const mmdc = findMmdc(packageRoot);
	const dot = await probe("dot", ["-V"]);
	const rsvg = await probe("rsvg-convert", ["--version"]);
	const magick = await probe("magick", ["-version"]);
	return {
		mermaid: mmdc
			? { available: true, detail: mmdc }
			: {
					available: false,
					detail:
						"mmdc not found. Run `npm install` inside the pi-learn package directory to add @mermaid-js/mermaid-cli.",
				},
		graphviz: dot.available ? { available: true, detail: "dot" } : { available: false, detail: "graphviz `dot` is not on PATH." },
		svg: rsvg.available
			? { available: true, detail: "rsvg-convert" }
			: magick.available
				? { available: true, detail: "magick" }
				: { available: false, detail: "Neither rsvg-convert nor magick is on PATH." },
	};
}

async function probe(command: string, args: string[]): Promise<RendererStatus> {
	const result = await run(command, args, { cwd: tmpdir(), timeoutMs: 5000 });
	if (result.code === 0) return { available: true, detail: command };
	return { available: false, detail: `${command} exited ${result.code ?? "null"}` };
}

/** Prefer the package's own install, then PATH. */
export function findMmdc(packageRoot: string): string | undefined {
	const local = join(packageRoot, "node_modules", ".bin", "mmdc");
	if (existsSync(local)) return local;
	return undefined;
}

// ── per-author managed source files ────────────────────────────────────────

export interface SourceFile {
	group: string;
	extension: string;
	path: string;
	workDir: string;
}

/**
 * Create (or reuse) the managed source file for one authoring group in one
 * process. Each child pi process owns its own staging directory, keyed by pid,
 * so two concurrent maker subagents never overwrite each other's source.
 */
export function openSource(group: string, extension: string): SourceFile {
	const workDir = join(STAGING_ROOT, `${group}-${process.pid}`);
	mkdirSync(workDir, { recursive: true });
	return { group, extension, workDir, path: join(workDir, `figure.${extension}`) };
}

export function writeSource(file: SourceFile, source: string): void {
	writeFileSync(file.path, source, "utf8");
}

export function readSource(file: SourceFile): string {
	return readFileSync(file.path, "utf8");
}

/**
 * All start indices where `needle` occurs, including overlapping matches.
 *
 * Advancing by one (not by `needle.length`) is what lets overlapping matches
 * be seen: in "aaa", "aa" occurs at 0 and 1.
 */
function findOccurrences(haystack: string, needle: string): number[] {
	const positions: number[] = [];
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) break;
		positions.push(at);
		from = at + 1;
	}
	return positions;
}

/**
 * Replace one exact-match region of the source.
 *
 * Stricter than pi's built-in edit in one deliberate way: pi counts
 * non-overlapping occurrences only (`split().length - 1`), so with two
 * overlapping matches it silently replaces the first. Here an ambiguous match —
 * overlapping or not — is refused. A figure is not version-controlled at this
 * layer and a silently wrong replacement would produce a picture that renders
 * cleanly and says something false, so failing loudly is the only safe choice.
 *
 * Returns the new text and the index of the change, so the caller can echo the
 * edited region back.
 */
export function applyEdit(current: string, oldText: string, newText: string): { updated: string; index: number } {
	if (oldText.length === 0) {
		throw new Error("old_text must not be empty (an empty target matches everywhere).");
	}
	const occurrences = findOccurrences(current, oldText);
	if (occurrences.length === 0) {
		throw new Error("old_text was not found in the current source; nothing changed.");
	}
	if (occurrences.length > 1) {
		const overlapping =
			occurrences[1] !== undefined && (occurrences[1] as number) < (occurrences[0] as number) + oldText.length;
		const where = occurrences.slice(0, 6).join(", ");
		const kind = overlapping ? " (the remaining matches overlap the first)" : "";
		throw new Error(
			`old_text matches ${occurrences.length} times, at offsets ${where}${kind}; it must match exactly once. ` +
				"Include more surrounding context to make it unique.",
		);
	}
	const index = occurrences[0] as number;
	return { updated: current.slice(0, index) + newText + current.slice(index + oldText.length), index };
}

/** A window of text around a change, for echoing the result back to the model. */
export function snippetAround(text: string, index: number, radius = 200): string {
	const start = Math.max(0, index - radius);
	const end = Math.min(text.length, index + radius);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

// ── publishing ─────────────────────────────────────────────────────────────

export interface Published {
	filename: string;
	path: string;
}

/**
 * Copy a rendered PNG into `<cwd>/viz/`, with a unique name.
 *
 * Never overwrites: the same lesson can legitimately be redrawn, and an
 * overwrite would silently change what an older note points at.
 */
export function publish(renderedPath: string, cwd: string, slug: string, now: Date = new Date()): Published {
	const directory = vizDir(cwd);
	mkdirSync(directory, { recursive: true });
	const filename = figureFilename(slug, now);
	let target = join(directory, filename);
	if (existsSync(target)) {
		target = uniquePath(directory, filename.replace(/\.png$/, ""), ".png");
	}
	writeFileSync(target, readFileSync(renderedPath));
	return { filename: target.split("/").pop() ?? filename, path: target };
}

// ── renderers ──────────────────────────────────────────────────────────────

export interface RenderOutcome {
	ok: boolean
	outPath: string
	detail: string
}

/** Render Mermaid source to PNG via mmdc. */
export async function renderMermaid(
	sourcePath: string,
	outPath: string,
	workDir: string,
	packageRoot: string,
	timeoutMs = 120_000,
): Promise<RenderOutcome> {
	const mmdc = findMmdc(packageRoot);
	if (!mmdc) {
		return {
			ok: false,
			outPath,
			detail:
				"mmdc not found. Run `npm install` in the pi-learn package directory (installs @mermaid-js/mermaid-cli).",
		};
	}
	const chrome = findChrome();
	const configPath = join(workDir, "puppeteer.json");
	writeFileSync(
		configPath,
		JSON.stringify(chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] }),
		"utf8",
	);
	const result = await run(
		mmdc,
		["-i", sourcePath, "-o", outPath, "-p", configPath, "-s", "2", "-b", "white"],
		{ cwd: workDir, timeoutMs, env: { PUPPETEER_SKIP_DOWNLOAD: "1" } },
	);
	if (result.code !== 0 || !existsSync(outPath)) {
		return { ok: false, outPath, detail: tail(result) };
	}
	return { ok: true, outPath, detail: "" };
}

/** Render Graphviz DOT source to PNG via `dot`. */
export async function renderGraphviz(sourcePath: string, outPath: string, workDir: string, timeoutMs = 60_000): Promise<RenderOutcome> {
	const result = await run("dot", ["-Tpng", "-Gdpi=144", sourcePath, "-o", outPath], { cwd: workDir, timeoutMs });
	if (result.code !== 0 || !existsSync(outPath)) return { ok: false, outPath, detail: tail(result) };
	return { ok: true, outPath, detail: "" };
}

/** Render hand-authored SVG to PNG: rsvg-convert first, ImageMagick as fallback. */
export async function renderSvg(sourcePath: string, outPath: string, workDir: string, timeoutMs = 60_000): Promise<RenderOutcome> {
	const rsvg = await run("rsvg-convert", ["-o", outPath, sourcePath], { cwd: workDir, timeoutMs });
	if (rsvg.code === 0 && existsSync(outPath)) return { ok: true, outPath, detail: "" };

	const magick = await run("magick", ["-background", "none", "-density", "144", sourcePath, outPath], {
		cwd: workDir,
		timeoutMs,
	});
	if (magick.code === 0 && existsSync(outPath)) return { ok: true, outPath, detail: "" };

	return {
		ok: false,
		outPath,
		detail: `rsvg-convert: ${tail(rsvg)}\n\nmagick: ${tail(magick)}`,
	};
}

function tail(result: RunResult, lines = 25): string {
	const text = (result.stderr || result.stdout || "unknown error").split("\n").slice(-lines).join("\n");
	return result.timedOut ? `timed out\n${text}` : text;
}

/** Convenience for the tools: absolute path to a rendered preview outside the project. */
export function previewPath(file: SourceFile): string {
	return join(file.workDir, `preview-${Date.now()}.png`);
}

export { slugify };

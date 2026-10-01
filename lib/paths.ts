/**
 * Path and naming helpers for pi-learn.
 *
 * Everything here is pure (it only touches `node:fs` through
 * {@link uniquePath}) so the tests can exercise it directly under
 * `node --test` without loading pi or pi-tui. The extensions import from this
 * module, so keep it free of any pi imports.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Directory, relative to the project root, that holds lesson markdown files. */
export const LESSONS_DIRNAME = "lessons";

/** Directory, relative to the project root, that holds rendered figures. */
export const VIZ_DIRNAME = "viz";

/** Maximum slug length; keeps filenames readable and well under filesystem limits. */
const MAX_SLUG_LENGTH = 60;

/**
 * Turn arbitrary topic text into a filename-safe slug.
 *
 * Non-ASCII letters are transliterated away rather than dropped mid-word, so
 * "Über die Methode" becomes "uber-die-methode" instead of "-ber-die-methode".
 * Returns "untitled" when nothing usable survives, so callers never have to
 * build a filename from an empty string.
 */
export function slugify(input: string): string {
	const slug = input
		.normalize("NFKD")
		// Strip combining marks left over from NFKD decomposition (é -> e +  ́).
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_LENGTH)
		// A slice can leave a trailing hyphen; trim again before returning.
		.replace(/-+$/g, "");
	return slug.length > 0 ? slug : "untitled";
}

/** Local-calendar date stamp (`YYYY-MM-DD`) for lesson filenames. */
export function dateStamp(now: Date = new Date()): string {
	const year = String(now.getFullYear()).padStart(4, "0");
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/** Absolute lessons directory for a project root. */
export function lessonsDir(cwd: string): string {
	return path.join(cwd, LESSONS_DIRNAME);
}

/** Absolute figures directory for a project root. */
export function vizDir(cwd: string): string {
	return path.join(cwd, VIZ_DIRNAME);
}

/**
 * Default lesson file path: `<cwd>/lessons/<YYYY-MM-DD>-<slug>.md`.
 *
 * This is the path `/learn-log <topic>` uses when the user passes a topic
 * instead of a file. It is deliberately deterministic so re-running it for the
 * same topic on the same day appends to the same lesson rather than scattering
 * near-duplicate files.
 */
export function defaultLessonPath(cwd: string, topic: string, now: Date = new Date()): string {
	return path.join(lessonsDir(cwd), `${dateStamp(now)}-${slugify(topic)}.md`);
}

/**
 * Resolve a lesson link argument against the project root.
 *
 * - A bare topic (no path separator, no `.md` suffix) becomes the dated default
 *   path under `lessons/`. This is the common case: `/learn-log recursion`.
 * - Anything else is treated as a user-chosen path, resolved relative to `cwd`
 *   when not absolute.
 */
export function resolveLessonPath(cwd: string, argument: string, now: Date = new Date()): string {
	const trimmed = argument.trim();
	if (trimmed.length === 0) return defaultLessonPath(cwd, "session", now);
	if (looksLikeTopic(trimmed)) return defaultLessonPath(cwd, trimmed, now);
	return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
}

/**
 * True when an argument names a subject rather than a file path.
 *
 * `/learn-log recursion` is a topic; `./notes/thing.md` is a path. The
 * distinction matters because a topic gets the dated default filename while an
 * explicit path is honoured exactly.
 */
export function looksLikeTopic(argument: string): boolean {
	const trimmed = argument.trim();
	if (trimmed.length === 0) return true;
	return !trimmed.includes("/") && !trimmed.includes("\\") && !trimmed.toLowerCase().endsWith(".md");
}

/**
 * Allocate a non-colliding path by appending `-2`, `-3`, … before the
 * extension until the name is free.
 *
 * Figure slugs come from model-authored topics, so collisions are expected
 * (the same lesson redrawn twice). Failing loudly would be hostile; silently
 * overwriting would destroy an image the learner may have referenced. Suffixing
 * is the only safe option, and it keeps filenames human-readable.
 */
export function uniquePath(directory: string, base: string, extension: string): string {
	const safeBase = slugify(base);
	const safeExtension = extension.startsWith(".") ? extension : `.${extension}`;
	let candidate = path.join(directory, `${safeBase}${safeExtension}`);
	let counter = 2;
	while (fs.existsSync(candidate)) {
		candidate = path.join(directory, `${safeBase}-${counter}${safeExtension}`);
		counter += 1;
	}
	return candidate;
}

/**
 * Build the published figure filename, e.g. `viz-internet-packets-1730421.png`.
 *
 * The timestamp comes from `now` so tests are deterministic. Unlike
 * {@link uniquePath} the caller is expected to pass an output directory that
 * may not exist yet; the render tools create it before publishing.
 */
export function figureFilename(slug: string, now: Date = new Date()): string {
	return `viz-${slugify(slug)}-${now.getTime()}.png`;
}

/**
 * Markdown embed for a figure, relative to the lesson file that embeds it.
 *
 * Uses standard markdown image syntax rather than Obsidian wikilinks: it
 * renders in Obsidian, on GitHub, and in any plain markdown viewer, and it
 * carries no vault-root assumption. `width` is emitted as an HTML attribute
 * wrapper only when the viewer would otherwise blow the image up full-bleed.
 */
export function figureEmbed(lessonFilePath: string, figurePath: string, width = 520): string {
	const relative = path.relative(path.dirname(lessonFilePath), figurePath).split(path.sep).join("/");
	const alt = slugify(path.basename(figurePath, path.extname(figurePath)));
	return `<img src="${relative}" alt="${alt}" width="${width}">`;
}

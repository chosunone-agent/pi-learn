import assert from "node:assert/strict";
import test from "node:test";
import { dateStamp, defaultLessonPath, figureEmbed, figureFilename, looksLikeTopic, resolveLessonPath, slugify, uniquePath } from "../lib/paths.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("slugify transliterates instead of dropping letters mid-word", () => {
	// The naive `[^a-z0-9]+ -> -` approach turns "Über" into "-ber" or "ber"
	// depending on order; both are worse than "uber".
	assert.equal(slugify("Über die Methode"), "uber-die-methode");
	assert.equal(slugify("Café résumé"), "cafe-resume");
});

test("slugify never returns an empty string, so no caller builds an empty filename", () => {
	for (const input of ["", "   ", "!!!", "🙂🙂", "...", "\n\t"]) {
		const slug = slugify(input);
		assert.notEqual(slug, "", `input ${JSON.stringify(input)} produced an empty slug`);
		assert.match(slug, /^[a-z0-9-]+$/, `input ${JSON.stringify(input)} produced ${slug}`);
	}
});

test("slugify collapses runs and trims edges", () => {
	assert.equal(slugify("  a --- b __ c  "), "a-b-c".replace("_", ""));
	assert.equal(slugify("a"), "a");
	assert.ok(!slugify("---leading").startsWith("-"));
	assert.ok(!slugify("trailing---").endsWith("-"));
});

test("slugify truncates long input and strips the hyphen the cut can leave", () => {
	const long = "word ".repeat(40).trim();
	const slug = slugify(long);
	assert.ok(slug.length <= 60, `slug was ${slug.length} chars`);
	assert.ok(!slug.endsWith("-"), `slug ended with a hyphen: ${slug}`);
});

test("dateStamp uses local calendar date, zero-padded", () => {
	// A date built with local components must round-trip: using UTC accessors
	// here would shift the label by a day for anyone east/west of UTC.
	const march = new Date(2026, 2, 5, 23, 30);
	assert.equal(dateStamp(march), "2026-03-05");
});

test("defaultLessonPath is deterministic for the same topic and day", () => {
	const now = new Date(2026, 2, 5, 10, 0);
	const first = defaultLessonPath("/proj", "Recursion", now);
	const second = defaultLessonPath("/proj", "recursion", now);
	assert.equal(first, second, "case differences must not produce two lesson files");
	assert.equal(first, "/proj/lessons/2026-03-05-recursion.md");
});

test("looksLikeTopic distinguishes subjects from paths", () => {
	assert.ok(looksLikeTopic("recursion"));
	assert.ok(looksLikeTopic(""));
	assert.ok(!looksLikeTopic("./notes/x.md"));
	assert.ok(!looksLikeTopic("notes/x.md"));
	assert.ok(!looksLikeTopic("X.MD"), "extension check must be case-insensitive");
	assert.ok(!looksLikeTopic("/abs/path.md"));
});

test("resolveLessonPath sends topics to the dated default and honours explicit paths", () => {
	const now = new Date(2026, 2, 5);
	assert.equal(resolveLessonPath("/proj", "recursion", now), "/proj/lessons/2026-03-05-recursion.md");
	assert.equal(resolveLessonPath("/proj", "notes/thing.md", now), "/proj/notes/thing.md");
	assert.equal(resolveLessonPath("/proj", "/elsewhere/thing.md", now), "/elsewhere/thing.md");
});

test("uniquePath suffixes rather than overwriting a figure the learner may reference", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-learn-uniq-"));
	try {
		const first = uniquePath(dir, "topic", ".png");
		assert.equal(first, join(dir, "topic.png"));
		writeFileSync(first, "x");
		assert.equal(uniquePath(dir, "topic", ".png"), join(dir, "topic-2.png"));
		writeFileSync(join(dir, "topic-2.png"), "x");
		assert.equal(uniquePath(dir, "topic", ".png"), join(dir, "topic-3.png"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("figureFilename embeds an explicit timestamp for determinism", () => {
	const now = new Date(1_730_421_000_000);
	assert.equal(figureFilename("internet packets", now), "viz-internet-packets-1730421000000.png");
});

test("figureEmbed produces a viewer-independent, relative reference", () => {
	const embed = figureEmbed("/proj/lessons/2026-03-05-tcp.md", "/proj/viz/viz-tcp-123.png");
	// Relative to the lesson file, not the project root: the lesson can be moved
	// with its images, and no vault root is assumed.
	assert.equal(embed, '<img src="../viz/viz-tcp-123.png" alt="viz-tcp-123" width="520">');
});

test("figureEmbed uses forward slashes on every platform", () => {
	const embed = figureEmbed("/proj/lessons/a.md", "/proj/viz/b.png");
	assert.ok(embed.includes("../viz/b.png"), embed);
	assert.ok(!embed.includes("\\"), "a backslash would break the reference on most viewers");
});

test("figureEmbed honours a custom width", () => {
	assert.ok(figureEmbed("/a/b.md", "/a/viz/c.png", 900).includes('width="900"'));
});

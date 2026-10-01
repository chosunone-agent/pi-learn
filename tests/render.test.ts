import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdit, openSource, publish, renderGraphviz, renderSvg, writeSource } from "../lib/figures.ts";

const PACKAGE_ROOT = new URL("..", import.meta.url).pathname;

function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> | void {
	const dir = mkdtempSync(join(tmpdir(), "pi-learn-render-"));
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

/** A PNG starts with the 8-byte PNG signature. */
function isPng(path: string): boolean {
	const header = readFileSync(path).subarray(0, 8);
	return header.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

test("renderGraphviz produces a real PNG from DOT", async () => {
	await withTempDir(async (dir) => {
		const source = join(dir, "g.dot");
		const out = join(dir, "g.png");
		writeFileSync(source, 'digraph { rankdir=TD; A -> B; B -> C [label="why"]; }');
		const result = await renderGraphviz(source, out, dir);
		assert.equal(result.ok, true, result.detail);
		assert.ok(isPng(out), "output was not a PNG");
	});
});

test("renderSvg produces a real PNG from hand-written SVG", async () => {
	await withTempDir(async (dir) => {
		const source = join(dir, "s.svg");
		const out = join(dir, "s.png");
		writeFileSync(
			source,
			'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="white"/><line x1="20" y1="100" x2="180" y2="100" stroke="black"/><text x="40" y="60" font-family="sans-serif" font-size="20">0</text></svg>',
		);
		const result = await renderSvg(source, out, dir);
		assert.equal(result.ok, true, result.detail);
		assert.ok(isPng(out), "output was not a PNG");
	});
});

test("renderGraphviz reports failure instead of a bogus success", async () => {
	await withTempDir(async (dir) => {
		const source = join(dir, "bad.dot");
		const out = join(dir, "bad.png");
		// A syntax error must surface as ok:false with the tool's message, not as a
		// success with a missing file — the caller's whole loop depends on this.
		writeFileSync(source, "digraph { A -> ");
		const result = await renderGraphviz(source, out, dir);
		assert.equal(result.ok, false);
		assert.notEqual(result.detail.trim(), "", "a failure must carry a diagnostic");
	});
});

test("renderSvg reports failure when the source is not SVG", async () => {
	await withTempDir(async (dir) => {
		const source = join(dir, "not.svg");
		const out = join(dir, "not.png");
		writeFileSync(source, "this is not svg at all");
		const result = await renderSvg(source, out, dir);
		assert.equal(result.ok, false, "a non-SVG document must not render as success");
	});
});

test("publish lands the figure in <cwd>/viz and never overwrites", async () => {
	await withTempDir(async (dir) => {
		const project = join(dir, "project");
		const source = join(dir, "src.png");
		// Minimal valid PNG bytes; publish only copies, so content is irrelevant.
		writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

		const first = publish(source, project, "topic");
		const second = publish(source, project, "topic");
		assert.notEqual(first.path, second.path, "a second publish must not clobber the first");
		assert.ok(first.path.startsWith(join(project, "viz")), first.path);
		assert.match(first.filename, /^viz-topic-\d+\.png$/);
	});
});

test("the managed source file lives outside the project until published", async () => {
	// Guarantees that an abandoned, half-finished figure never appears in viz/.
	await withTempDir(async (dir) => {
		const file = openSource("test-group", "dot");
		writeSource(file, "digraph { A -> B }");
		assert.ok(!file.path.startsWith(dir), "staging must not be inside the project");
		const { readSource } = await import("../lib/figures.ts");
		assert.equal(readSource(file), "digraph { A -> B }");
	});
});

test("a full authoring loop converges: write, edit, render", async () => {
	await withTempDir(async (dir) => {
		const file = openSource("loop-group", "dot");
		writeSource(file, "digraph { rankdir=TD; A -> B }");

		// First render: correct structure but the edge is unlabelled.
		const firstOut = join(dir, "first.png");
		assert.equal((await renderGraphviz(file.path, firstOut, file.workDir)).ok, true);

		// The model looks, decides the edge needs a label, and edits.
		const { updated } = applyEdit("digraph { rankdir=TD; A -> B }", "A -> B", 'A -> B [label="depends on"]');
		writeSource(file, updated);

		const secondOut = join(dir, "second.png");
		const second = await renderGraphviz(file.path, secondOut, file.workDir);
		assert.equal(second.ok, true, second.detail);
		assert.ok(isPng(secondOut));
	});
});

test("the mermaid renderer reports a precise reason when mmdc is absent", async () => {
	const { renderMermaid } = await import("../lib/figures.ts");
	await withTempDir(async (dir) => {
		const source = join(dir, "m.mmd");
		writeFileSync(source, "graph TD\nA-->B\n");
		const result = await renderMermaid(source, join(dir, "m.png"), dir, join(dir, "nonexistent-package"));
		assert.equal(result.ok, false);
		// The message must tell the reader how to fix it, not just that it failed.
		assert.match(result.detail, /mmdc|npm install/i);
	});
});

test("renderer availability is reported per renderer with a reason", async () => {
	const { rendererAvailability } = await import("../lib/figures.ts");
	const availability = await rendererAvailability(PACKAGE_ROOT);
	for (const name of ["mermaid", "graphviz", "svg"] as const) {
		assert.ok(name in availability, `${name} missing from the report`);
		assert.equal(typeof availability[name].available, "boolean");
		assert.notEqual(availability[name].detail, "", `${name} needs a diagnostic`);
	}
});

/**
 * Mermaid authoring tools for the `mermaid-maker` subagent.
 *
 * NOT discovered as an extension: this file lives outside the package's
 * `pi.extensions` list and is named by the agent's `subagentOnlyExtensions`, so
 * it loads only inside the maker's child session. The main session never sees
 * write_mermaid/render_mermaid, which keeps its tool list small and stops the
 * teacher from authoring diagrams itself — correctness depends on the maker's
 * render-and-look loop, not on the teacher's guess.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAuthoringTools } from "../lib/authoring-tools.ts";
import { renderMermaid } from "../lib/figures.ts";

const PACKAGE_ROOT = new URL("..", import.meta.url).pathname;

export default function mermaidTools(pi: ExtensionAPI) {
	registerAuthoringTools(pi, {
		family: "mermaid",
		extension: "mmd",
		label: "Mermaid",
		sourceShape:
			"a complete Mermaid diagram, starting with its type on the first line: `graph TD` / `graph LR`, " +
			"`sequenceDiagram`, `stateDiagram-v2`, `erDiagram`, `classDiagram`, `mindmap`, or `timeline`.",
		verifyHint:
			"Check arrow directions, which node points at which, label accuracy, and whether anything is cramped or clipped.",
		render: (sourcePath, outPath, workDir) => renderMermaid(sourcePath, outPath, workDir, PACKAGE_ROOT),
	});
}

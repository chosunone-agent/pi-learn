/**
 * Graphviz authoring tools for the `graphviz-maker` subagent.
 *
 * Same shape as the mermaid tools, offered because DOT gives layout control
 * that Mermaid does not: explicit ranks, edge weights, clusters, and precise
 * placement. It is the right choice when a Mermaid layout puts related things
 * far apart or crosses edges for no reason. See mermaid-tools.ts for why this
 * file is not a discovered extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAuthoringTools } from "../lib/authoring-tools.ts";
import { renderGraphviz } from "../lib/figures.ts";

export default function graphvizTools(pi: ExtensionAPI) {
	registerAuthoringTools(pi, {
		family: "graphviz",
		extension: "dot",
		label: "Graphviz",
		sourceShape:
			"a complete DOT digraph, e.g. `digraph { rankdir=TD; A -> B [label=\"why\"]; }`. Use `rank` and " +
			"`{rank=same; ...}` to steer layout, and `cluster_*` subgraphs to group related nodes.",
		verifyHint:
			"Check arrow direction and labels first, then whether the layout groups related nodes and avoids needless edge crossings.",
		render: (sourcePath, outPath, workDir) => renderGraphviz(sourcePath, outPath, workDir),
	});
}

/**
 * SVG authoring tools for the `svg-maker` subagent.
 *
 * Hand-authored SVG is the only correct option when positions matter: number
 * lines, vectors, function plots, annotated geometry, physical layouts. Mermaid
 * and Graphviz lay out automatically; here you place every element, which is
 * exactly why an unchecked mistake (a right-angle mark on the wrong corner, a
 * point plotted at the wrong coordinate) survives — hence the mandatory
 * render-and-look step.
 *
 * See mermaid-tools.ts for why this file is not a discovered extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAuthoringTools } from "../lib/authoring-tools.ts";
import { renderSvg } from "../lib/figures.ts";

export default function svgTools(pi: ExtensionAPI) {
	registerAuthoringTools(pi, {
		family: "svg",
		extension: "svg",
		label: "SVG",
		sourceShape:
			"a complete `<svg>…</svg>` document with an explicit width and height (or a viewBox), a white or " +
			"transparent background, `font-family=\"sans-serif\"`, and generous font sizes. Leave margins so " +
			"nothing touches the edge.",
		verifyHint:
			"Re-derive the geometry: are coordinates, angles, directions, and proportions actually right? Are labels clear, off the lines they annotate, and unclipped?",
		render: (sourcePath, outPath, workDir) => renderSvg(sourcePath, outPath, workDir),
	});
}

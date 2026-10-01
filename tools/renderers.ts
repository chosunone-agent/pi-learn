/**
 * `renderers` — report which figure renderers work here, and how to fix the ones that do not.
 *
 * Not a discovered extension: it is named by each maker agent's
 * `subagentOnlyExtensions`, so it is available exactly where it is useful —
 * inside a maker session that cannot produce a picture. The failure mode it
 * addresses is opaque: a maker that cannot render otherwise reports only that
 * the render failed, which looks like a source problem when it is an
 * environment problem.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rendererAvailability } from "../lib/figures.ts";

const PACKAGE_ROOT = new URL("..", import.meta.url).pathname;

export default function renderers(pi: ExtensionAPI) {
	pi.registerCommand("renderers", {
		description: "Show which figure renderers (mermaid, graphviz, svg) are available and how to fix any that are not",
		handler: async (_args, ctx) => {
			const availability = await rendererAvailability(PACKAGE_ROOT);
			const lines: string[] = ["Figure renderers:"];
			for (const [name, status] of Object.entries(availability)) {
				const mark = status.available ? "ok" : "MISSING";
				lines.push(`  ${name.padEnd(9)} ${mark.padEnd(8)} ${status.detail}`);
			}
			if (!availability.svg.available || !availability.graphviz.available) {
				lines.push("", "Install the missing system tools: `graphviz` (dot), `librsvg` (rsvg-convert) or `imagemagick` (magick).");
			}
			if (!availability.mermaid.available) {
				lines.push("", "Mermaid needs this package's dependencies: run `npm install` in the pi-learn package directory.");
			}
			const report = lines.join("\n");
			ctx.ui.notify(report, availability.mermaid.available && availability.graphviz.available && availability.svg.available ? "info" : "warning");
			// Returning the text also puts it in the transcript, where a maker can
			// read it in context rather than only seeing a transient notification.
			return report;
		},
	});
}

/**
 * The authoring loop shared by every figure renderer.
 *
 * Each family (mermaid, graphviz, svg) exposes the same three-tool shape:
 *
 *   write_<family>   replace the managed source wholesale
 *   edit_<family>    one exact-match replacement in the managed source
 *   render_<family>  render the current source and RETURN THE IMAGE
 *
 * The tools deliberately do not let the model name a file. The source lives in
 * a per-process staging directory and the rendered preview in the OS temp dir,
 * so nothing enters the learner's project until the author explicitly publishes
 * with `save_as`. That keeps half-finished figures out of `viz/`.
 *
 * `render_*` returns the PNG as tool-result image content. Pi draws that inline
 * in the terminal (kitty graphics, which WezTerm supports), so the author
 * literally looks at the picture and iterates — the "verify by looking"
 * guarantee the whole visualization design rests on — without needing a
 * separate viewer or a vault.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type RenderOutcome,
	type SourceFile,
	applyEdit,
	openSource,
	previewPath,
	publish,
	readSource,
	rendererAvailability,
	snippetAround,
	writeSource,
} from "./figures.ts";

export interface AuthoringSpec {
	/** Short family id used in tool names, e.g. "mermaid" → write_mermaid. */
	family: string;
	/** Source file extension without a dot. */
	extension: string;
	/** Human label for tool titles, e.g. "Mermaid". */
	label: string;
	/** Renderer implementation. */
	render: (sourcePath: string, outPath: string, workDir: string) => Promise<RenderOutcome>;
	/** What a complete source document should look like, for the write tool. */
	sourceShape: string;
	/** Guidance specific to this renderer's failure modes. */
	verifyHint: string;
}

export function registerAuthoringTools(pi: ExtensionAPI, spec: AuthoringSpec): void {
	let source: SourceFile | null = null;

	const writeName = `write_${spec.family}`;
	const editName = `edit_${spec.family}`;
	const renderName = `render_${spec.family}`;

	pi.registerTool({
		name: writeName,
		label: `Write ${spec.label}`,
		description:
			`Write a COMPLETE ${spec.label} source document to this session's managed file. ` +
			`Use it for a first draft or a full rewrite; for a small fix prefer ${editName}. ` +
			`You never name the file — ${editName} and ${renderName} act on the same one. ` +
			`Writing does not render; call ${renderName} when ready.\n\n` +
			`Expected shape: ${spec.sourceShape}`,
		parameters: Type.Object({
			source: Type.String({ description: `The complete ${spec.label} source document.` }),
		}),
		async execute(_id: string, params: { source?: string }) {
			const text = (params.source ?? "").trim();
			if (!text) throw new Error(`${writeName} requires a non-empty source.`);
			source = openSource(spec.family, spec.extension);
			writeSource(source, `${text}\n`);
			const lines = text.split("\n").length;
			return {
				content: [
					{
						type: "text" as const,
						text: `Wrote ${lines} lines of ${spec.label} source.\nCall ${renderName} to render and look at it, or ${editName} to tweak it.`,
					},
				],
				details: { ok: true, path: source.path, lines },
			};
		},
	});

	pi.registerTool({
		name: editName,
		label: `Edit ${spec.label}`,
		description:
			`Make ONE exact-match replacement in this session's ${spec.label} source — the same ` +
			`contract as pi's built-in edit, locked to the single managed file. old_text must ` +
			`appear EXACTLY ONCE; include surrounding context to make it unique. On zero or ` +
			`multiple matches the call fails and nothing changes. Call ${writeName} first. ` +
			`Editing does not render.`,
		parameters: Type.Object({
			old_text: Type.String({ description: "Exact substring of the current source to replace (must match exactly once)." }),
			new_text: Type.String({ description: "Replacement text for old_text." }),
		}),
		async execute(_id: string, params: { old_text?: string; new_text?: string }) {
			if (!source) throw new Error(`${editName}: no source yet — call ${writeName} first.`);
			const current = readSource(source);
			const { updated, index } = applyEdit(current, String(params.old_text ?? ""), String(params.new_text ?? ""));
			writeSource(source, updated);
			return {
				content: [
					{
						type: "text" as const,
						text: `Applied edit. Updated region:\n\n\`\`\`\n${snippetAround(updated, index)}\n\`\`\`\nCall ${renderName} to look at the result.`,
					},
				],
				details: { ok: true, path: source.path },
			};
		},
	});

	pi.registerTool({
		name: renderName,
		label: `Render ${spec.label}`,
		description:
			`Render the CURRENT ${spec.label} source to a PNG and return the image so you can SEE ` +
			`it and iterate. Iterate freely without save_as (preview only, nothing is saved). When ` +
			`the picture is correct and clean, call once more with save_as set to a short kebab-case ` +
			`topic: the PNG is published into <project>/viz with a unique name and the filename is ` +
			`returned for you to embed. ${spec.verifyHint}\n\n` +
			`Rendering succeeding only proves the source parsed. You are done only once you have ` +
			`LOOKED at the returned image and confirmed it says what the brief asked and nothing false.`,
		parameters: Type.Object({
			save_as: Type.Optional(
				Type.String({
					description:
						"Short kebab-case topic slug, e.g. 'internet-packets'. When set, the render is published to <project>/viz as viz-<slug>-<timestamp>.png and the filename is returned. Omit for a preview-only render.",
				}),
			),
		}),
		async execute(_id: string, params: { save_as?: string }, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
			if (!source) throw new Error(`${renderName}: no source yet — call ${writeName} first.`);
			const outPath = previewPath(source);
			const outcome = await spec.render(source.path, outPath, source.workDir);

			if (!outcome.ok) {
				return {
					content: [
						{
							type: "text" as const,
							text: `${spec.label} render FAILED — no image produced. Fix the source with ${editName} and call ${renderName} again.\n\nError:\n${outcome.detail}`,
						},
					],
					details: { ok: false, path: "" },
				};
			}

			const data = readPngBase64(outcome.outPath);
			if (params.save_as) {
				const published = publish(outcome.outPath, ctx.cwd, params.save_as);
				return {
					content: [
						{
							type: "text" as const,
							text: `Published.\nfilename: ${published.filename}\npath: ${published.path}\n\nLOOK at the image below and confirm it is correct before you finish.`,
						},
						{ type: "image" as const, data, mimeType: "image/png" },
					],
					details: { ok: true, path: published.path, filename: published.filename },
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Preview render (not saved). LOOK at it now: ${spec.verifyHint} Fix with ${editName}, or re-render with save_as to publish.`,
					},
					{ type: "image" as const, data, mimeType: "image/png" },
				],
				details: { ok: true, path: outcome.outPath },
			};
		},
	});
}

/** Read a rendered PNG and encode it for inline display. */
function readPngBase64(path: string): string {
	return readFileSync(path).toString("base64");
}

/** Expose availability so a maker can report a missing renderer precisely. */
export async function describeAvailability(packageRoot: string): Promise<string> {
	const all = await rendererAvailability(packageRoot);
	return Object.entries(all)
		.map(([name, status]) => `${name}: ${status.available ? "ok" : "unavailable"} (${status.detail})`)
		.join("\n");
}

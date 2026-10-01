/**
 * Keep the interactive teaching tools out of the model's tool list when there is
 * no UI.
 *
 * `teach_ask` and `teach_quiz` need a terminal to render a dialog. In a
 * non-interactive run (`pi -p`, a script, an RPC host without dialogs) they are
 * unusable, and a model that sees them anyway will burn a tool call discovering
 * that — which is worse than not having them, because the failure is only
 * visible from the tool result.
 *
 * Pi exposes the declared tool set through `getActiveTools()` /
 * `setActiveTools()`, so the fix is to reconcile that set against `ctx.hasUI`
 * before each turn's snapshot is read, on `before_agent_start`. The in-handler
 * `hasUI` guards stay as a backstop in case the ordering ever changes.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Strip or restore the given tools to match `ctx.hasUI`.
 *
 * Idempotent, and it only ever adds or removes its own tool names, so it cannot
 * disturb a user's `--tools` selection, another extension's tools, or the
 * built-in set.
 */
export function reconcileInteractiveTools(pi: ExtensionAPI, ctx: ExtensionContext, toolNames: readonly string[]): void {
	const active = pi.getActiveTools();
	const present = toolNames.filter((name) => active.includes(name));

	if (!ctx.hasUI && present.length > 0) {
		pi.setActiveTools(active.filter((name) => !toolNames.includes(name)));
		return;
	}
	if (ctx.hasUI && present.length < toolNames.length) {
		const missing = toolNames.filter((name) => !active.includes(name));
		pi.setActiveTools([...active, ...missing]);
	}
}

/** Attach the reconciler for `toolNames` to `before_agent_start`. */
export function registerInteractiveToolReconciler(pi: ExtensionAPI, toolNames: readonly string[]): void {
	pi.on("before_agent_start", (_event, ctx) => reconcileInteractiveTools(pi, ctx, toolNames));
}

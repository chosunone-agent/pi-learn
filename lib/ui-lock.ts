/**
 * A process-wide mutex for pop-up UI.
 *
 * `ctx.ui.custom()` hands one component control of the interactive area. Two
 * concurrent custom components would fight for the same screen rows, so every
 * pop-up this package opens (`teach_ask`, `teach_quiz`) must serialize.
 *
 * The lock lives on `globalThis` under a package-specific key so the two
 * extensions share one queue even though they do not import each other. The
 * key is deliberately distinct from any other package's key: sharing a lock
 * with an implementation whose lifetime or reentrancy rules we do not control
 * would be worse than having two independent locks.
 */

const SHARED_UI_LOCK_KEY = "__piLearnUiLock";

interface UiLock {
	withLock<T>(fn: () => T | Promise<T>): Promise<T>;
}

function createLock(): UiLock {
	let chain: Promise<void> = Promise.resolve();
	return {
		withLock<T>(fn: () => T | Promise<T>): Promise<T> {
			const previous = chain;
			let release!: () => void;
			chain = new Promise<void>((resolve) => {
				release = resolve;
			});
			// `previous` never rejects: the chained promise is created above and
			// only ever resolved, so a throwing `fn` cannot poison the queue.
			return previous.then(fn).finally(() => release());
		},
	};
}

function getSharedUiLock(): UiLock {
	const globalObject = globalThis as Record<string, unknown>;
	const existing = globalObject[SHARED_UI_LOCK_KEY];
	if (existing) return existing as UiLock;
	const created = createLock();
	globalObject[SHARED_UI_LOCK_KEY] = created;
	return created;
}

/** Run `fn` with exclusive access to the pop-up UI. */
export function withUiLock<T>(fn: () => T | Promise<T>): Promise<T> {
	return getSharedUiLock().withLock(fn);
}

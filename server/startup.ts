/**
 * Acquire exclusive network ownership before mutating persisted runtime state.
 * Recovery remains synchronous, so request handling cannot interleave before it completes.
 */
export function acquireListenerAndRecover<T>(
	acquireListener: () => T,
	recoverOrphanedCrawls: () => void,
): T {
	const listener = acquireListener();
	recoverOrphanedCrawls();
	return listener;
}

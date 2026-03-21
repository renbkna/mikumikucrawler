/**
 * Wraps a promise with a timeout.
 * If the promise doesn't resolve within the timeout, it rejects with a TimeoutError.
 */
export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	operation: string,
): Promise<T> {
	let settled = false;
	return Promise.race([
		promise.then(
			(v) => {
				settled = true;
				return v;
			},
			(e) => {
				settled = true;
				throw e;
			},
		),
		Bun.sleep(ms).then(() => {
			if (settled) return undefined as never;
			throw new Error(`Timeout: ${operation} exceeded ${ms}ms`);
		}),
	]);
}

/**
 * Like withTimeout, but resolves with a fallback value instead of rejecting.
 * Use for operations where a timeout is acceptable and a default is preferred over an error.
 */
export function withTimeoutFallback<T>(
	promise: Promise<T>,
	ms: number,
	fallback: T,
): Promise<T> {
	let settled = false;
	return Promise.race([
		promise.then(
			(v) => {
				settled = true;
				return v;
			},
			(e) => {
				settled = true;
				throw e;
			},
		),
		Bun.sleep(ms).then(() => {
			if (settled) return undefined as never;
			return fallback;
		}),
	]);
}

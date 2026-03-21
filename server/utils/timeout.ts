/**
 * Wraps a promise with a timeout.
 * If the promise doesn't resolve within the timeout, it rejects with a TimeoutError.
 */
export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	operation: string,
): Promise<T> {
	return Promise.race([
		promise,
		Bun.sleep(ms).then(() => {
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
	return Promise.race([promise, Bun.sleep(ms).then(() => fallback)]);
}

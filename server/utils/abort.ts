/** The error an aborted operation rejects with: the signal's reason when it is an Error. */
export function abortError(signal: AbortSignal, fallbackMessage = "Operation aborted"): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error(fallbackMessage, { cause: signal.reason });
}

/**
 * Settles with `promise`, or rejects as soon as `signal` aborts. The underlying
 * operation keeps running; callers that own it must release it themselves.
 */
export function raceAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	reason: (signal: AbortSignal) => Error = abortError,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(reason(signal));

	return new Promise<T>((resolve, reject) => {
		const rejectOnAbort = () => reject(reason(signal));
		signal.addEventListener("abort", rejectOnAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", rejectOnAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", rejectOnAbort);
				reject(error);
			},
		);
	});
}

/**
 * Runs `listener` when `signal` aborts (immediately if it already has) until the
 * returned registration is disposed.
 */
export function onAbort(signal: AbortSignal | undefined, listener: () => void): Disposable {
	if (!signal) return { [Symbol.dispose]() {} };
	if (signal.aborted) {
		listener();
		return { [Symbol.dispose]() {} };
	}
	signal.addEventListener("abort", listener, { once: true });
	return {
		[Symbol.dispose]() {
			signal.removeEventListener("abort", listener);
		},
	};
}

export class OperationTimeoutError extends Error {
	constructor(operationName: string, timeoutMs: number) {
		super(`Timeout: ${operationName} exceeded ${timeoutMs}ms`);
		this.name = "OperationTimeoutError";
	}
}

interface RunWithTimeoutOptions<T> {
	timeoutMs: number;
	operationName: string;
	signal?: AbortSignal;
	run: (signal: AbortSignal) => Promise<T>;
}

interface RunWithTimeoutFallbackOptions<T> extends RunWithTimeoutOptions<T> {
	fallback: T;
}

function getAbortError(
	operationSignal: AbortSignal,
	timeoutSignal: AbortSignal,
	externalSignal: AbortSignal | undefined,
	operationName: string,
	timeoutMs: number,
): Error {
	if (timeoutSignal.aborted && !externalSignal?.aborted) {
		return new OperationTimeoutError(operationName, timeoutMs);
	}

	const reason = externalSignal?.reason ?? operationSignal.reason;
	return reason instanceof Error
		? reason
		: new Error(`${operationName} aborted`);
}

/**
 * Runs an operation with a single AbortSignal-based deadline model.
 *
 * The signal is created before the operation starts, so abort-aware operations
 * can stop work. The race remains as the deadline bridge for operations that
 * do not observe AbortSignal themselves.
 */
export async function runWithTimeout<T>({
	timeoutMs,
	operationName,
	signal,
	run,
}: RunWithTimeoutOptions<T>): Promise<T> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const operationSignal = signal
		? AbortSignal.any([signal, timeoutSignal])
		: timeoutSignal;

	let removeAbortListener = () => {};
	const abortPromise = new Promise<never>((_, reject) => {
		const rejectWithAbort = () => {
			removeAbortListener();
			reject(
				getAbortError(
					operationSignal,
					timeoutSignal,
					signal,
					operationName,
					timeoutMs,
				),
			);
		};

		if (operationSignal.aborted) {
			rejectWithAbort();
			return;
		}

		operationSignal.addEventListener("abort", rejectWithAbort, {
			once: true,
		});
		removeAbortListener = () => {
			operationSignal.removeEventListener("abort", rejectWithAbort);
		};
	});

	const operationPromise = Promise.resolve().then(() => run(operationSignal));
	operationPromise.catch(() => {});

	try {
		return await Promise.race([operationPromise, abortPromise]);
	} catch (error) {
		if (timeoutSignal.aborted && !signal?.aborted) {
			throw new OperationTimeoutError(operationName, timeoutMs);
		}
		throw error;
	} finally {
		removeAbortListener();
	}
}

/**
 * Like runWithTimeout, but resolves with a fallback only when the timeout
 * deadline expires. External aborts and operation failures still reject.
 */
export async function runWithTimeoutFallback<T>(
	options: RunWithTimeoutFallbackOptions<T>,
): Promise<T> {
	try {
		return await runWithTimeout(options);
	} catch (error) {
		if (error instanceof OperationTimeoutError) {
			return options.fallback;
		}
		throw error;
	}
}

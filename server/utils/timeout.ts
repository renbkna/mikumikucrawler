export class OperationTimeoutError extends Error {
	constructor(operationName: string, timeoutMs: number, cause?: unknown) {
		super(
			`Timeout: ${operationName} exceeded ${timeoutMs}ms`,
			cause !== undefined ? { cause } : undefined,
		);
		this.name = "OperationTimeoutError";
	}
}

interface RunWithTimeoutOptions<T> {
	timeoutMs: number;
	operationName: string;
	signal?: AbortSignal;
	run: (signal: AbortSignal) => Promise<T>;
}

function getAbortError(
	operationSignal: AbortSignal,
	timeoutSignal: AbortSignal,
	externalSignal: AbortSignal | undefined,
	operationName: string,
	timeoutMs: number,
): Error {
	if (timeoutSignal.aborted && !externalSignal?.aborted) {
		return new OperationTimeoutError(operationName, timeoutMs, operationSignal.reason);
	}

	const reason = externalSignal?.reason ?? operationSignal.reason;
	return reason instanceof Error ? reason : new Error(`${operationName} aborted`);
}

/**
 * Runs an operation with a single AbortSignal-based deadline model.
 *
 * The signal is created before the operation starts, so abort-aware operations
 * can stop work. A deadline is not settlement: after abort wins the race, this
 * owner waits for the operation to release its resources before returning.
 */
export async function runWithTimeout<T>({
	timeoutMs,
	operationName,
	signal,
	run,
}: RunWithTimeoutOptions<T>): Promise<T> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	let removeAbortListener = () => {};
	const abortPromise = new Promise<never>((_, reject) => {
		const rejectWithAbort = () => {
			removeAbortListener();
			reject(getAbortError(operationSignal, timeoutSignal, signal, operationName, timeoutMs));
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

	const operationPromise = Promise.resolve().then(() => {
		operationSignal.throwIfAborted();
		return run(operationSignal);
	});

	try {
		return await Promise.race([operationPromise, abortPromise]);
	} catch (error) {
		const rejection =
			timeoutSignal.aborted && !signal?.aborted
				? getAbortError(operationSignal, timeoutSignal, signal, operationName, timeoutMs)
				: error;
		await Promise.allSettled([operationPromise]);
		throw rejection;
	} finally {
		removeAbortListener();
	}
}

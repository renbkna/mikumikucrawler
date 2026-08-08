const API_REQUEST_TIMEOUT_MS = 30_000;

export function createRequestSignal(
	lifetimeSignal?: AbortSignal,
	timeoutMs = API_REQUEST_TIMEOUT_MS,
): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return lifetimeSignal ? AbortSignal.any([lifetimeSignal, timeoutSignal]) : timeoutSignal;
}

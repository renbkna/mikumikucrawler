import { TIMEOUT_CONSTANTS } from "../constants.js";

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
 * Timeout wrapper for static fetch operations.
 */
export function withFetchTimeout<T>(promise: Promise<T>): Promise<T> {
	return withTimeout(promise, TIMEOUT_CONSTANTS.STATIC_FETCH, "HTTP request");
}

/**
 * Timeout wrapper for dynamic rendering (Puppeteer).
 */
export function withRenderTimeout<T>(promise: Promise<T>): Promise<T> {
	return withTimeout(
		promise,
		TIMEOUT_CONSTANTS.DYNAMIC_RENDER,
		"Dynamic render",
	);
}

/**
 * Timeout wrapper for content processing (HTML parsing).
 */
export function withProcessingTimeout<T>(promise: Promise<T>): Promise<T> {
	return withTimeout(
		promise,
		TIMEOUT_CONSTANTS.CONTENT_PROCESSING,
		"Content processing",
	);
}

/**
 * Timeout wrapper for database operations.
 */
export function withDatabaseTimeout<T>(promise: Promise<T>): Promise<T> {
	return withTimeout(
		promise,
		TIMEOUT_CONSTANTS.DATABASE_OPERATION,
		"Database operation",
	);
}

/**
 * Custom timeout error class.
 */
export class TimeoutError extends Error {
	constructor(operation: string, timeoutMs: number) {
		super(`Operation "${operation}" timed out after ${timeoutMs}ms`);
		this.name = "TimeoutError";
	}
}

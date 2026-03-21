/**
 * Single domain error class for the crawler.
 * Uses a `code` discriminant instead of a class hierarchy.
 * Supports native `Error.cause` chaining.
 */

export const ErrorCode = {
	// SSRF validation failures
	SSRF_EMPTY_HOST: "SSRF_EMPTY_HOST",
	SSRF_LOCALHOST: "SSRF_LOCALHOST",
	SSRF_PRIVATE_IP: "SSRF_PRIVATE_IP",
	SSRF_DNS_FAILURE: "SSRF_DNS_FAILURE",
	SSRF_RESOLVED_PRIVATE: "SSRF_RESOLVED_PRIVATE",

	// Network errors
	NETWORK_TIMEOUT: "NETWORK_TIMEOUT",
	NETWORK_HTTP: "NETWORK_HTTP",
	NETWORK_TOO_LARGE: "NETWORK_TOO_LARGE",

	// Browser/Puppeteer errors
	BROWSER_CRASHED: "BROWSER_CRASHED",
	BROWSER_TIMEOUT: "BROWSER_TIMEOUT",
	BROWSER_CONTEXT_DESTROYED: "BROWSER_CONTEXT_DESTROYED",
	BROWSER_DETACHED: "BROWSER_DETACHED",
	BROWSER_TARGET_CLOSED: "BROWSER_TARGET_CLOSED",

	// Validation
	VALIDATION_URL: "VALIDATION_URL",
	VALIDATION_OPTIONS: "VALIDATION_OPTIONS",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class CrawlerError extends Error {
	readonly code: ErrorCode;

	constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.code = code;
		this.name = "CrawlerError";
	}

	static isSSRF(error: unknown): error is CrawlerError {
		return error instanceof CrawlerError && error.code.startsWith("SSRF_");
	}

	static isBrowser(error: unknown): error is CrawlerError {
		return error instanceof CrawlerError && error.code.startsWith("BROWSER_");
	}

	static isNetwork(error: unknown): error is CrawlerError {
		return error instanceof CrawlerError && error.code.startsWith("NETWORK_");
	}
}

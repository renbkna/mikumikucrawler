import type { ApiError } from "./contracts/errors.js";
import type { ValidationErrorDetail } from "./contracts/http.js";
import type { LoggerLike } from "./types.js";
import { getErrorMessage } from "./utils/helpers.js";

function readNumericStatus(value: unknown): number | null {
	return typeof value === "number" && value >= 400 && value < 600
		? value
		: null;
}

function readStringField(
	error: unknown,
	key: "message" | "summary",
): string | null {
	if (!error || typeof error !== "object" || !(key in error)) {
		return null;
	}

	const value = (error as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function readJsonSummary(value: string | null): string | null {
	if (!value || !value.trim().startsWith("{")) {
		return null;
	}

	try {
		const parsed = JSON.parse(value) as {
			summary?: unknown;
			message?: unknown;
		};
		if (typeof parsed.summary === "string" && parsed.summary.length > 0) {
			return parsed.summary;
		}
		if (typeof parsed.message === "string" && parsed.message.length > 0) {
			return parsed.message;
		}
	} catch {}

	return null;
}

function readValidationDetails(error: unknown): ValidationErrorDetail[] | null {
	if (!error || typeof error !== "object" || !("all" in error)) {
		return null;
	}

	const all = (error as Record<string, unknown>).all;
	if (!Array.isArray(all)) {
		return null;
	}

	const details = all.flatMap((item) => {
		if (!item || typeof item !== "object") {
			return [];
		}

		const path = (item as Record<string, unknown>).path;
		const summary = (item as Record<string, unknown>).summary;
		const message = (item as Record<string, unknown>).message;

		const resolvedMessage =
			typeof summary === "string" && summary.length > 0
				? summary
				: typeof message === "string" && message.length > 0
					? message
					: null;

		if (typeof path !== "string" || !resolvedMessage) {
			return [];
		}

		return [{ path, message: resolvedMessage }];
	});

	return details.length > 0 ? details : null;
}

export function resolveErrorStatus(
	code: string | number,
	error: unknown,
	currentStatus?: number | string,
): number {
	if (typeof code === "number" && code >= 400 && code < 600) {
		return code;
	}

	if (code === "NOT_FOUND") {
		return 404;
	}

	const explicitStatus = readNumericStatus(currentStatus);
	if (explicitStatus && explicitStatus !== 500) {
		return explicitStatus;
	}

	const errorStatus =
		error && typeof error === "object"
			? readNumericStatus((error as Record<string, unknown>).status)
			: null;
	if (errorStatus) {
		return errorStatus;
	}

	if (code === "VALIDATION") {
		return 422;
	}

	if (code === "PARSE") {
		return 400;
	}

	if (code === "INVALID_COOKIE_SIGNATURE") {
		return 400;
	}

	if (code === "INVALID_FILE_TYPE") {
		return 422;
	}

	return 500;
}

function buildPublicErrorMessage(status: number, error: unknown): string {
	if (status >= 500) {
		return error instanceof Error ? error.message : "Internal Server Error";
	}

	return (
		readStringField(error, "summary") ??
		readJsonSummary(readStringField(error, "message")) ??
		readStringField(error, "message") ??
		getErrorMessage(error)
	);
}

export function handleAppError({
	code,
	error,
	set,
	logger,
}: {
	code: string | number;
	error: unknown;
	set: { status?: number | string };
	logger: LoggerLike;
}): ApiError {
	if (code === "NOT_FOUND") {
		set.status = 404;
		return { error: "Not Found" };
	}

	const status = resolveErrorStatus(code, error, set.status);
	if (status >= 500) {
		logger.error(`[App] ${getErrorMessage(error)}`);
	}

	set.status = status;

	const details = status < 500 ? readValidationDetails(error) : null;
	return {
		error: buildPublicErrorMessage(status, error),
		details: details ?? undefined,
	};
}

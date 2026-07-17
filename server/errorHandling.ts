import { ValidationError } from "elysia";
import type { ApiError } from "./contracts/errors.js";
import type { ValidationErrorDetail } from "./contracts/http.js";
import type { LoggerLike } from "./types.js";
import { getErrorMessage } from "./utils/helpers.js";

export function resolveErrorStatus(code: string | number): number {
	if (typeof code === "number" && code >= 400 && code < 600) {
		return code;
	}

	if (code === "NOT_FOUND") return 404;
	if (code === "VALIDATION" || code === "INVALID_FILE_TYPE") return 422;
	if (code === "PARSE" || code === "INVALID_COOKIE_SIGNATURE") return 400;
	return 500;
}

function validationDetails(error: unknown): ValidationErrorDetail[] | undefined {
	if (!(error instanceof ValidationError)) {
		return undefined;
	}

	const details = error.all.flatMap(({ path, summary, message }) => {
		const resolvedMessage = summary ?? message;
		return typeof path === "string" && resolvedMessage ? [{ path, message: resolvedMessage }] : [];
	});

	return details.length > 0 ? details : undefined;
}

function publicErrorMessage(code: string | number, status: number, error: unknown): string {
	if (status >= 500) return "Internal Server Error";
	if (code === "NOT_FOUND") return "Not Found";
	if (code === "PARSE") return "Bad Request";

	if (error instanceof ValidationError) {
		return error.all[0]?.summary ?? error.all[0]?.message ?? "Validation failed";
	}

	return getErrorMessage(error);
}

export function handleAppError({
	code,
	error,
	logger,
}: {
	code: string | number;
	error: unknown;
	logger: LoggerLike;
}): { status: number; body: ApiError } {
	const status = resolveErrorStatus(code);
	if (status >= 500) {
		logger.error(`[App] ${getErrorMessage(error)}`);
	}

	return {
		status,
		body: {
			error: publicErrorMessage(code, status, error),
			details: validationDetails(error),
		},
	};
}

import { InvalidCookie, NotFound, ParseError, ValidationError } from "elysia";
import type { ApiError } from "./contracts/errors.js";
import type { ValidationErrorDetail } from "./contracts/http.js";
import type { LoggerLike } from "./types.js";
import { getErrorMessage } from "./utils/helpers.js";

function resolveErrorStatus(error: unknown): number {
	if (error instanceof NotFound) return 404;
	if (error instanceof ValidationError) return 422;
	if (error instanceof ParseError) return 400;
	if (error instanceof InvalidCookie && error.status === 400) return 400;
	return 500;
}

function validationDetails(error: unknown): ValidationErrorDetail[] | undefined {
	if (!(error instanceof ValidationError)) {
		return undefined;
	}

	const details = error.payload.errors?.flatMap(({ instancePath, message }) => {
		return typeof instancePath === "string" && typeof message === "string"
			? [{ path: instancePath, message }]
			: [];
	});

	return details && details.length > 0 ? details : undefined;
}

function publicErrorMessage(status: number, error: unknown): string {
	if (status >= 500) return "Internal Server Error";
	if (error instanceof NotFound) return "Not Found";
	if (error instanceof ParseError) return "Bad Request";

	if (error instanceof ValidationError) {
		return error.all[0]?.summary ?? error.all[0]?.message ?? "Validation failed";
	}

	return getErrorMessage(error);
}

export function handleAppError({ error, logger }: { error: unknown; logger: LoggerLike }): {
	status: number;
	body: ApiError;
} {
	const status = resolveErrorStatus(error);
	if (status >= 500) {
		logger.error(`[App] ${getErrorMessage(error)}`);
	}

	return {
		status,
		body: {
			error: publicErrorMessage(status, error),
			details: validationDetails(error),
		},
	};
}

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error), { cause: error });
}

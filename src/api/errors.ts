export function getApiErrorMessage(
	value: unknown,
	fallback = "Request failed",
): string {
	if (!value || typeof value !== "object") {
		return fallback;
	}

	if ("error" in value && typeof value.error === "string") {
		return value.error;
	}

	if ("message" in value && typeof value.message === "string") {
		return value.message;
	}

	return fallback;
}

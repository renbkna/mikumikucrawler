export interface PageContentResponse {
	status: "ok";
	content: string | null;
}

export function isPageContentResponse(
	value: unknown,
): value is PageContentResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { status?: unknown }).status === "ok" &&
		((value as { content?: unknown }).content === null ||
			typeof (value as { content?: unknown }).content === "string")
	);
}

export function mediaTypeFromContentType(contentType: string): string {
	return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function isHtmlLikeContentType(contentType: string): boolean {
	const normalized = mediaTypeFromContentType(contentType);
	return normalized === "text/html" || normalized === "application/xhtml+xml";
}

export function isJsonContentType(contentType: string): boolean {
	const normalized = mediaTypeFromContentType(contentType);
	return normalized === "application/json" || normalized.endsWith("+json");
}

export function isPdfContentType(contentType: string): boolean {
	return mediaTypeFromContentType(contentType) === "application/pdf";
}

import { PDF_CONSTANTS, REQUEST_CONSTANTS } from "../constants.js";

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

export function isSupportedDocumentContentType(contentType: string): boolean {
	return (
		isHtmlLikeContentType(contentType) ||
		isJsonContentType(contentType) ||
		isPdfContentType(contentType)
	);
}

export function maxProcessableDocumentBytes(contentType: string): number {
	return isPdfContentType(contentType)
		? PDF_CONSTANTS.MAX_FILE_SIZE_MB * 1024 * 1024
		: REQUEST_CONSTANTS.MAX_TEXT_DOCUMENT_BYTES;
}

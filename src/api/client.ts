import { treaty } from "@elysiajs/eden";
import type { App } from "../../server/app";

const backendUrl = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";

/** Type-safe Eden Treaty client for the Miku Crawler API */
export const api = treaty<App>(backendUrl);

export function getBackendUrl(): string {
	return backendUrl.replace(/\/$/, "");
}

export type CrawlExportFormat = "json" | "csv";

function getErrorMessageFromResponseBody(body: unknown): string {
	if (!body || typeof body !== "object") {
		return "Request failed";
	}

	if ("error" in body && typeof body.error === "string") {
		return body.error;
	}

	if ("message" in body && typeof body.message === "string") {
		return body.message;
	}

	return "Request failed";
}

export async function downloadCrawlExport(
	crawlId: string,
	format: CrawlExportFormat,
): Promise<{ blob: Blob; filename: string }> {
	const response = await fetch(
		`${getBackendUrl()}/api/crawls/${crawlId}/export?format=${format}`,
	);

	if (!response.ok) {
		let body: unknown = null;
		try {
			body = await response.json();
		} catch {}
		throw new Error(getErrorMessageFromResponseBody(body));
	}

	const contentDisposition = response.headers.get("content-disposition");
	const fileNameMatch = contentDisposition?.match(/filename="([^"]+)"/);

	return {
		blob: await response.blob(),
		filename: fileNameMatch?.[1] ?? `miku-crawler-export.${format}`,
	};
}

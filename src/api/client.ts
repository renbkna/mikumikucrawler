import { treaty } from "@elysiajs/eden";
import type { App } from "../../server/app";
import { getApiErrorMessage } from "./errors";

const backendUrl = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";

/** Type-safe Eden Treaty client for the Miku Crawler API */
export const api = treaty<App>(backendUrl);

export function getBackendUrl(): string {
	return backendUrl.replace(/\/$/, "");
}

export type CrawlExportFormat = "json" | "csv";

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
		throw new Error(getApiErrorMessage(body));
	}

	const contentDisposition = response.headers.get("content-disposition");
	const fileNameMatch = contentDisposition?.match(/filename="([^"]+)"/);

	return {
		blob: await response.blob(),
		filename: fileNameMatch?.[1] ?? `miku-crawler-export.${format}`,
	};
}

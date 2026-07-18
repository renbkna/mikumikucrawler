import { type Treaty, treaty } from "@elysiajs/eden";
import type { App } from "../../server/app";
import {
	buildCrawlEventsPath,
	buildCrawlExportPath,
	type CrawlExportFormat,
} from "../../shared/contracts/index.js";
import { buildBackendApiUrl, resolveBackendUrl } from "./backendUrl";
import { getApiErrorMessage } from "./errors";

const backendUrl = resolveBackendUrl({
	VITE_BACKEND_URL: import.meta.env.VITE_BACKEND_URL,
});

/** Type-safe Eden Treaty client for the Miku Crawler API */
export const api: Treaty.Create<App> = treaty<App>(backendUrl, {
	// API timestamps are JSON wire strings. Eden's default Date revival would
	// violate the shared response contract before browser-side validation.
	parseDate: false,
});

export type { CrawlExportFormat } from "../../shared/contracts/index.js";

export function getBackendUrl(): string {
	return backendUrl;
}

export function getBackendApiUrl(path: string): string {
	return buildBackendApiUrl(getBackendUrl(), path);
}

export function createCrawlEventSource(crawlId: string): EventSource {
	return new EventSource(getBackendApiUrl(buildCrawlEventsPath(crawlId)));
}

export async function downloadCrawlExport(
	crawlId: string,
	format: CrawlExportFormat,
): Promise<{ blob: Blob; filename: string }> {
	const response = await fetch(getBackendApiUrl(buildCrawlExportPath(crawlId, format)));

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

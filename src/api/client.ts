import { type Treaty, treaty } from "@elysia/eden";
import type { App } from "../../server/app";
import {
	buildCrawlEventsPath,
	buildCrawlExportPath,
	type CrawlExportFormat,
} from "../../shared/contracts/index.js";
import { resolveBackendUrl } from "./backendUrl";

export const backendUrl = resolveBackendUrl({
	VITE_BACKEND_URL: import.meta.env.VITE_BACKEND_URL,
});

/** Type-safe Eden Treaty client for the Miku Crawler API */
export const api: Treaty.Create<App> = treaty<App>(backendUrl, {
	// API timestamps are JSON wire strings. Eden's default Date revival would
	// violate the shared response contract before browser-side validation.
	parseDate: false,
});

export function createCrawlEventSource(crawlId: string): EventSource {
	return new EventSource(`${backendUrl}${buildCrawlEventsPath(crawlId)}`);
}

export function getCrawlExportUrl(crawlId: string, format: CrawlExportFormat): string {
	return `${backendUrl}${buildCrawlExportPath(crawlId, format)}`;
}

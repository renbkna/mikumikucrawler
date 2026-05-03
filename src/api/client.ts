import { treaty } from "@elysiajs/eden";
import type { App } from "../../server/app";
import {
	buildCrawlEventsPath,
	buildCrawlExportPath,
	type CrawlExportFormat,
} from "../../shared/contracts/index.js";
import { getApiErrorMessage } from "./errors";

interface BackendUrlEnv {
	VITE_BACKEND_URL?: string;
	DEV?: boolean;
}

export function resolveBackendUrl(
	env: BackendUrlEnv,
	origin = globalThis.window?.location.origin,
): string {
	if (env.VITE_BACKEND_URL) {
		return env.VITE_BACKEND_URL;
	}

	if (env.DEV) {
		return "http://localhost:3000";
	}

	return origin ?? "http://localhost";
}

const backendUrl = resolveBackendUrl(import.meta.env);

/** Type-safe Eden Treaty client for the Miku Crawler API */
export const api = treaty<App>(backendUrl);

export type { CrawlExportFormat } from "../../shared/contracts/index.js";

export function getBackendUrl(): string {
	return backendUrl.replace(/\/$/, "");
}

export function getBackendApiUrl(path: string): string {
	return `${getBackendUrl()}${path}`;
}

export function createCrawlEventSource(crawlId: string): EventSource {
	return new EventSource(getBackendApiUrl(buildCrawlEventsPath(crawlId)));
}

export async function downloadCrawlExport(
	crawlId: string,
	format: CrawlExportFormat,
): Promise<{ blob: Blob; filename: string }> {
	const response = await fetch(
		getBackendApiUrl(buildCrawlExportPath(crawlId, format)),
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

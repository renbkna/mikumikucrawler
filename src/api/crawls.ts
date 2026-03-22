import type { CrawlSummary } from "../../shared/contracts/crawl.js";
import type { CrawlEventEnvelope } from "../../shared/contracts/events.js";
import type { CrawlOptions } from "../types";
import {
	api,
	type CrawlExportFormat,
	downloadCrawlExport,
	getBackendUrl,
} from "./client";
import { getApiErrorMessage } from "./errors";
import { parseCrawlEventEnvelope } from "./crawlEvents";

export type { CrawlExportFormat } from "./client";

export interface ApiSuccess<T> {
	ok: true;
	data: T;
}

export interface ApiFailure {
	ok: false;
	error: string;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export interface InterruptedSessionSummary {
	id: string;
	target: string;
	status: string;
	pagesScanned: number;
	createdAt: string;
	updatedAt: string;
}

function toInterruptedSessionSummary(
	crawl: CrawlSummary,
): InterruptedSessionSummary {
	return {
		id: crawl.id,
		target: crawl.target,
		status: crawl.status,
		pagesScanned: crawl.counters.pagesScanned,
		createdAt: crawl.createdAt,
		updatedAt: crawl.updatedAt,
	};
}

export async function createCrawl(
	options: CrawlOptions,
): Promise<ApiResult<CrawlSummary>> {
	const response = await api.api.crawls.post(options);
	if (response.error || !response.data) {
		return { ok: false, error: getApiErrorMessage(response.error?.value) };
	}
	return { ok: true, data: response.data };
}

export async function stopCrawl(
	crawlId: string,
): Promise<ApiResult<CrawlSummary>> {
	const response = await api.api.crawls({ id: crawlId }).stop.post();
	if (response.error || !response.data) {
		return { ok: false, error: getApiErrorMessage(response.error?.value) };
	}
	return { ok: true, data: response.data };
}

export async function resumeCrawl(
	crawlId: string,
): Promise<ApiResult<CrawlSummary>> {
	const response = await api.api.crawls({ id: crawlId }).resume.post();
	if (response.error || !response.data) {
		return { ok: false, error: getApiErrorMessage(response.error?.value) };
	}
	return { ok: true, data: response.data };
}

export async function listInterruptedCrawls(): Promise<
	ApiResult<InterruptedSessionSummary[]>
> {
	const response = await api.api.crawls.get({
		query: { status: "interrupted" },
	});

	if (response.error || !response.data) {
		return { ok: false, error: getApiErrorMessage(response.error?.value) };
	}

	return {
		ok: true,
		data: response.data.crawls.map(toInterruptedSessionSummary),
	};
}

export async function deleteCrawl(
	crawlId: string,
): Promise<ApiResult<{ deleted: true }>> {
	const response = await api.api.crawls({ id: crawlId }).delete();
	if (response.error) {
		return { ok: false, error: getApiErrorMessage(response.error.value) };
	}
	return { ok: true, data: { deleted: true } };
}

export async function exportCrawl(
	crawlId: string,
	format: CrawlExportFormat,
): Promise<ApiResult<{ blob: Blob; filename: string }>> {
	try {
		const result = await downloadCrawlExport(crawlId, format);
		return { ok: true, data: result };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "Failed to export crawl",
		};
	}
}

export interface CrawlEventSubscription {
	close(): void;
}

function createEnvelopeListener(
	handler: (event: CrawlEventEnvelope) => void,
): EventListener {
	return (event) => {
		if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
			return;
		}

		const envelope = parseCrawlEventEnvelope(event.data);
		if (envelope) {
			handler(envelope);
		}
	};
}

function createSignalListener(handler: () => void): EventListener {
	return () => {
		handler();
	};
}

export function subscribeToCrawlEvents(
	crawlId: string,
	handlers: {
		onOpen: () => void;
		onError: () => void;
		onEvent: (event: CrawlEventEnvelope) => void;
	},
): CrawlEventSubscription {
	const source = new EventSource(
		`${getBackendUrl()}/api/crawls/${crawlId}/events`,
	);
	const handleEnvelope = createEnvelopeListener(handlers.onEvent);

	source.addEventListener("open", createSignalListener(handlers.onOpen));
	source.addEventListener("error", createSignalListener(handlers.onError));

	for (const type of [
		"crawl.log",
		"crawl.page",
		"crawl.progress",
		"crawl.started",
		"crawl.completed",
		"crawl.stopped",
		"crawl.failed",
	]) {
		source.addEventListener(type, handleEnvelope);
	}

	return {
		close() {
			source.close();
		},
	};
}

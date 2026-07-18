import type {
	CrawlEventEnvelope,
	CrawlExportFormat,
	CrawlOptions,
	CrawlRecoverySnapshot,
	CrawlSummary,
	ResumableSessionSummary,
	StopCrawlMode,
} from "../../shared/contracts/index.js";
import {
	CrawlEventTypeValues,
	isCrawlListResponse,
	isCrawlRecoverySnapshot,
	isCrawlSummary,
	toResumableSessionSummary,
} from "../../shared/contracts/index.js";
import { parseCrawlEventEnvelope } from "../../shared/contracts/validation.js";
import { api, createCrawlEventSource, downloadCrawlExport } from "./client";
import { getApiErrorMessage } from "./errors";
import type { ApiResult } from "./result";

export async function createCrawl(options: CrawlOptions): Promise<ApiResult<CrawlSummary>> {
	const response = await api.api.crawls.post(options);
	if (response.error || !response.data) {
		return { ok: false, error: getApiErrorMessage(response.error?.value) };
	}
	if (!isCrawlSummary(response.data)) {
		return { ok: false, error: "Unexpected crawl response" };
	}
	return { ok: true, data: response.data };
}

export async function getCrawlRecoverySnapshot(
	crawlId: string,
	signal?: AbortSignal,
): Promise<ApiResult<CrawlRecoverySnapshot>> {
	const response = await api.api
		.crawls({ id: crawlId })
		.snapshot.get(signal ? { fetch: { signal } } : undefined);
	if (response.error || !response.data) {
		return { ok: false, error: getApiErrorMessage(response.error?.value) };
	}
	if (!isCrawlRecoverySnapshot(response.data)) {
		return { ok: false, error: "Unexpected crawl recovery response" };
	}
	return { ok: true, data: response.data };
}

export async function stopCrawl(
	crawlId: string,
	mode: StopCrawlMode = "pause",
): Promise<ApiResult<CrawlSummary>> {
	const response = await api.api.crawls({ id: crawlId }).stop.post({ mode });
	if (response.error || !response.data) {
		return { ok: false, error: getApiErrorMessage(response.error?.value) };
	}
	if (!isCrawlSummary(response.data)) {
		return { ok: false, error: "Unexpected crawl response" };
	}
	return { ok: true, data: response.data };
}

export async function resumeCrawl(crawlId: string): Promise<ApiResult<CrawlRecoverySnapshot>> {
	const response = await api.api.crawls({ id: crawlId }).resume.post();
	if (response.error || !response.data) {
		return { ok: false, error: getApiErrorMessage(response.error?.value) };
	}
	if (!isCrawlRecoverySnapshot(response.data)) {
		return { ok: false, error: "Unexpected crawl response" };
	}
	return { ok: true, data: response.data };
}

export async function listResumableCrawls(): Promise<ApiResult<ResumableSessionSummary[]>> {
	const response = await api.api.crawls.resumable.get();
	if (response.error || !response.data) {
		return { ok: false, error: getApiErrorMessage(response.error?.value) };
	}

	if (!isCrawlListResponse(response.data)) {
		return { ok: false, error: "Unexpected crawl list response" };
	}

	return {
		ok: true,
		data: response.data.crawls.map(toResumableSessionSummary),
	};
}

export async function deleteCrawl(crawlId: string): Promise<ApiResult<void>> {
	const response = await api.api.crawls({ id: crawlId }).delete();
	if (response.error) {
		return { ok: false, error: getApiErrorMessage(response.error.value) };
	}
	return { ok: true, data: undefined };
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

function createEnvelopeListener(handler: (event: CrawlEventEnvelope) => void): EventListener {
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
	const source = createCrawlEventSource(crawlId);
	const handleEnvelope = createEnvelopeListener(handlers.onEvent);

	source.addEventListener("open", createSignalListener(handlers.onOpen));
	source.addEventListener("error", createSignalListener(handlers.onError));

	for (const type of CrawlEventTypeValues) {
		source.addEventListener(type, handleEnvelope);
	}

	return {
		close() {
			source.close();
		},
	};
}

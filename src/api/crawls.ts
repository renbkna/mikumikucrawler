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
	isCrawlRecoverySnapshot,
	isCrawlSummary,
	isDeleteCrawlResponse,
	isResumableCrawlListResponse,
	toResumableSessionSummary,
} from "../../shared/contracts/index.js";
import { parseCrawlEventEnvelope } from "../../shared/contracts/validation.js";
import { api, createCrawlEventSource, getCrawlExportUrl } from "./client";
import { getApiErrorMessage } from "./errors";
import { createRequestSignal } from "./requestLifetime";
import type { ApiResult } from "./result";

export async function createCrawl(
	crawlId: string,
	options: CrawlOptions,
	lifetimeSignal?: AbortSignal,
): Promise<ApiResult<CrawlSummary>> {
	const signal = createRequestSignal(lifetimeSignal);
	const response = await api.api.crawls.post({ id: crawlId, options }, { fetch: { signal } });
	if (response.error || !response.data) {
		const status = response.error?.status;
		return {
			ok: false,
			error: getApiErrorMessage(response.error?.value),
			...(typeof status === "number" ? { status } : {}),
		};
	}
	if (!isCrawlSummary(response.data)) {
		return { ok: false, error: "Unexpected crawl response" };
	}
	if (response.data.id !== crawlId) {
		return { ok: false, error: "Crawl response identity mismatch" };
	}
	return { ok: true, data: response.data };
}

export async function getCrawlRecoverySnapshot(
	crawlId: string,
	lifetimeSignal?: AbortSignal,
): Promise<ApiResult<CrawlRecoverySnapshot>> {
	const signal = createRequestSignal(lifetimeSignal);
	const response = await api.api.crawls({ id: crawlId }).snapshot.get({ fetch: { signal } });
	if (response.error || !response.data) {
		const status = response.error?.status;
		return {
			ok: false,
			error: getApiErrorMessage(response.error?.value),
			...(typeof status === "number" ? { status } : {}),
		};
	}
	if (!isCrawlRecoverySnapshot(response.data)) {
		return { ok: false, error: "Unexpected crawl recovery response" };
	}
	if (response.data.crawl.id !== crawlId) {
		return { ok: false, error: "Crawl recovery response identity mismatch" };
	}
	return { ok: true, data: response.data };
}

export async function stopCrawl(
	crawlId: string,
	mode: StopCrawlMode = "pause",
	lifetimeSignal?: AbortSignal,
): Promise<ApiResult<CrawlSummary>> {
	const signal = createRequestSignal(lifetimeSignal);
	const response = await api.api.crawls({ id: crawlId }).stop.post({ mode }, { fetch: { signal } });
	if (response.error || !response.data) {
		const status = response.error?.status;
		return {
			ok: false,
			error: getApiErrorMessage(response.error?.value),
			...(typeof status === "number" ? { status } : {}),
		};
	}
	if (!isCrawlSummary(response.data)) {
		return { ok: false, error: "Unexpected crawl response" };
	}
	if (response.data.id !== crawlId) {
		return { ok: false, error: "Crawl response identity mismatch" };
	}
	return { ok: true, data: response.data };
}

export async function resumeCrawl(
	crawlId: string,
	lifetimeSignal?: AbortSignal,
): Promise<ApiResult<CrawlRecoverySnapshot>> {
	const signal = createRequestSignal(lifetimeSignal);
	const response = await api.api.crawls({ id: crawlId }).resume.post(undefined, {
		fetch: { signal },
	});
	if (response.error || !response.data) {
		return { ok: false, error: getApiErrorMessage(response.error?.value) };
	}
	if (!isCrawlRecoverySnapshot(response.data)) {
		return { ok: false, error: "Unexpected crawl response" };
	}
	if (response.data.crawl.id !== crawlId) {
		return { ok: false, error: "Crawl response identity mismatch" };
	}
	return { ok: true, data: response.data };
}

export async function listResumableCrawls(
	lifetimeSignal?: AbortSignal,
): Promise<ApiResult<ResumableSessionSummary[]>> {
	const signal = createRequestSignal(lifetimeSignal);
	const response = await api.api.crawls.resumable.get({ fetch: { signal } });
	if (response.error || !response.data) {
		return { ok: false, error: getApiErrorMessage(response.error?.value) };
	}

	if (!isResumableCrawlListResponse(response.data)) {
		return { ok: false, error: "Unexpected crawl list response" };
	}

	return {
		ok: true,
		data: response.data.crawls.map(toResumableSessionSummary),
	};
}

export async function deleteCrawl(
	crawlId: string,
	lifetimeSignal?: AbortSignal,
): Promise<ApiResult<void>> {
	const signal = createRequestSignal(lifetimeSignal);
	const response = await api.api.crawls({ id: crawlId }).delete({ fetch: { signal } });
	if (response.error || !response.data) {
		return { ok: false, error: getApiErrorMessage(response.error?.value) };
	}
	if (!isDeleteCrawlResponse(response.data)) {
		return { ok: false, error: "Unexpected delete response" };
	}
	return { ok: true, data: undefined };
}

export async function downloadCrawlExport(
	crawlId: string,
	format: CrawlExportFormat,
	signal?: AbortSignal,
): Promise<ApiResult<{ blob: Blob; filename: string }>> {
	const response = await fetch(getCrawlExportUrl(crawlId, format), { signal });
	if (!response.ok) {
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			// The status still identifies non-JSON failures.
		}
		return {
			ok: false,
			error: getApiErrorMessage(body, `Export failed (${response.status})`),
			status: response.status,
		};
	}

	const filename = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1];
	return {
		ok: true,
		data: {
			blob: await response.blob(),
			filename: filename ?? `crawl-export.${format}`,
		},
	};
}

function createEnvelopeListener(
	handler: (event: CrawlEventEnvelope) => void,
	onInvalidEvent: () => void,
): EventListener {
	return (event) => {
		if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
			onInvalidEvent();
			return;
		}

		const envelope = parseCrawlEventEnvelope(event.data);
		if (envelope) {
			handler(envelope);
		} else {
			onInvalidEvent();
		}
	};
}

export function subscribeToCrawlEvents(
	crawlId: string,
	handlers: {
		onOpen: () => void;
		onError: () => void;
		onInvalidEvent: () => void;
		onEvent: (event: CrawlEventEnvelope) => void;
	},
) {
	const source = createCrawlEventSource(crawlId);
	const handleEnvelope = createEnvelopeListener(handlers.onEvent, handlers.onInvalidEvent);

	source.addEventListener("open", handlers.onOpen);
	source.addEventListener("error", handlers.onError);

	for (const type of CrawlEventTypeValues) {
		source.addEventListener(type, handleEnvelope);
	}

	return { close: () => source.close() };
}

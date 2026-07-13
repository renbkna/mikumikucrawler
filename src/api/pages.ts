import type { CrawlPagesResponse, PageContentResponse } from "../../shared/contracts/index.js";
import { isCrawlPagesResponse, isPageContentResponse } from "../../shared/contracts/index.js";
import { api } from "./client";
import { getApiErrorMessage } from "./errors";
import type { ApiResult } from "./result";

export const PAGE_CONTENT_REQUEST_TIMEOUT_MS = 15_000;

export function createPageContentRequestSignal(
	lifetimeSignal: AbortSignal,
	timeoutMs = PAGE_CONTENT_REQUEST_TIMEOUT_MS,
): AbortSignal {
	return AbortSignal.any([lifetimeSignal, AbortSignal.timeout(timeoutMs)]);
}

export async function getPageContent(
	pageId: number,
	signal?: AbortSignal,
): Promise<ApiResult<PageContentResponse>> {
	const { data, error } = await api.api
		.pages({ id: pageId })
		.content.get(signal ? { fetch: { signal } } : undefined);

	if (error) {
		return {
			ok: false,
			error: getApiErrorMessage(error.value, "Failed to load"),
		};
	}

	if (!isPageContentResponse(data)) {
		return { ok: false, error: "Invalid page content response" };
	}

	return { ok: true, data };
}

export async function listCrawlPages(
	crawlId: string,
	signal?: AbortSignal,
): Promise<ApiResult<CrawlPagesResponse>> {
	const { data, error } = await api.api
		.crawls({ id: crawlId })
		.pages.get(signal ? { fetch: { signal } } : undefined);
	if (error) {
		return {
			ok: false,
			error: getApiErrorMessage(error.value, "Failed to load crawl pages"),
		};
	}
	if (!isCrawlPagesResponse(data)) {
		return { ok: false, error: "Invalid crawl page response" };
	}
	return { ok: true, data };
}

import type { PageContentResponse } from "../../shared/contracts/index.js";
import { isPageContentResponse } from "../../shared/contracts/index.js";
import { api } from "./client";
import { getApiErrorMessage } from "./errors";
import { createRequestSignal } from "./requestLifetime";
import type { ApiResult } from "./result";

const PAGE_CONTENT_REQUEST_TIMEOUT_MS = 15_000;

export async function getPageContent(
	crawlId: string,
	pageId: number,
	signal?: AbortSignal,
): Promise<ApiResult<PageContentResponse>> {
	const requestSignal = createRequestSignal(signal, PAGE_CONTENT_REQUEST_TIMEOUT_MS);
	const response = await api.api
		.crawls({ id: crawlId })
		.pages({ pageId })
		.content.get({ fetch: { signal: requestSignal } });
	const { data, error } = response;

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

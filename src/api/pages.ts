import type { PageContentResponse } from "../../shared/contracts/page.js";
import { isPageContentResponse } from "../../shared/contracts/page.js";
import { api } from "./client";
import { getApiErrorMessage } from "./errors";
import type { ApiResult } from "./result";

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

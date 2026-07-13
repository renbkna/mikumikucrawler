import type { CrawledPage } from "../../shared/contracts/index.js";
import { api } from "./client";
import { getApiErrorMessage } from "./errors";
import type { ApiResult } from "./result";

export const DURABLE_SEARCH_RESULT_LIMIT = 100;

export interface DurablePageSearchResult {
	count: number;
	pages: CrawledPage[];
}

export async function searchStoredPages(
	crawlId: string,
	query: string,
	signal?: AbortSignal,
): Promise<ApiResult<DurablePageSearchResult>> {
	const response = await api.api.search.get({
		query: { crawlId, q: query, limit: DURABLE_SEARCH_RESULT_LIMIT },
		...(signal ? { fetch: { signal } } : {}),
	});

	if (response.error || !response.data) {
		return {
			ok: false,
			error: getApiErrorMessage(response.error?.value, "Search failed"),
		};
	}

	return {
		ok: true,
		data: {
			count: response.data.count,
			pages: response.data.results.map((result) => ({
				id: result.id,
				url: result.url,
				title: result.title || undefined,
				description: result.snippet || result.description || undefined,
				domain: result.domain,
			})),
		},
	};
}

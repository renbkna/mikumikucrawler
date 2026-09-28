import { isSearchResponse, type SearchResponse } from "../../shared/contracts/index.js";
import { api } from "./client";
import { createRequestSignal } from "./requestLifetime";
import { type ApiResult, mapApiResult, unwrapApiResponse } from "./result";

export const DURABLE_SEARCH_RESULT_LIMIT = 100;

export type DurablePageSearchResult = Pick<SearchResponse, "count" | "results">;

export async function searchStoredPages(
	crawlId: string,
	query: string,
	signal?: AbortSignal,
): Promise<ApiResult<DurablePageSearchResult>> {
	const requestSignal = createRequestSignal(signal);
	const response = await api.api.search.get({
		query: { crawlId, q: query, limit: DURABLE_SEARCH_RESULT_LIMIT },
		fetch: { signal: requestSignal },
	});

	return mapApiResult(
		unwrapApiResponse(response, {
			isValid: isSearchResponse,
			invalidMessage: "Unexpected search response",
			failureMessage: "Search failed",
			identity: {
				matches: (search) => search.crawlId === crawlId && search.query === query,
				message: "Unexpected search response",
			},
		}),
		({ count, results }) => ({ count, results }),
	);
}

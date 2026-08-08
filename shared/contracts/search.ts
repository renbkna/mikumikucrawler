import { t } from "elysia/type-system";
import type { Static } from "typebox";
import { API_LIST_LIMIT_BOUNDS } from "./http.js";
import { maxUtf16LengthForCodePoints, PAGE_TEXT_LIMITS } from "./pageData.js";
import { StoredPageIdSchema } from "./schemas.js";

/** Maximum editable search text accepted by the API and browser. */
export const MAX_SEARCH_QUERY_LENGTH = 256;

export const SearchResultSchema = t.Object({
	id: StoredPageIdSchema,
	url: t.String(),
	title: t.String({
		maxLength: maxUtf16LengthForCodePoints(PAGE_TEXT_LIMITS.summaryTextCharacters),
	}),
	description: t.String({
		maxLength: maxUtf16LengthForCodePoints(PAGE_TEXT_LIMITS.summaryTextCharacters),
	}),
	domain: t.String(),
	snippet: t.String({
		maxLength: maxUtf16LengthForCodePoints(PAGE_TEXT_LIMITS.searchSnippetCharacters),
	}),
});

export const SearchResponseSchema = t.Object({
	crawlId: t.String(),
	query: t.String({ minLength: 1, maxLength: MAX_SEARCH_QUERY_LENGTH }),
	count: t.Integer({ minimum: 0 }),
	results: t.Array(SearchResultSchema, { maxItems: API_LIST_LIMIT_BOUNDS.max }),
});

export type SearchResult = Static<typeof SearchResultSchema>;
export type SearchResponse = Static<typeof SearchResponseSchema>;

import { t } from "elysia";
import { optionalBoundedListLimitSchema } from "../../shared/contracts/http.js";
import {
	MAX_SEARCH_QUERY_LENGTH,
	SearchResponseSchema,
	type SearchResult,
} from "../../shared/contracts/search.js";

export { SearchResponseSchema, type SearchResult };

export const DEFAULT_SEARCH_LIMIT = 20;

export const SearchQuerySchema = t.Object({
	crawlId: t.String({ minLength: 1 }),
	q: t.String({ minLength: 1, maxLength: MAX_SEARCH_QUERY_LENGTH }),
	limit: optionalBoundedListLimitSchema(DEFAULT_SEARCH_LIMIT),
});

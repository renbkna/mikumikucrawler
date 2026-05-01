import { t } from "elysia";
import { optionalBoundedListLimitSchema } from "./http.js";

export const DEFAULT_SEARCH_LIMIT = 20;

export const SearchQuerySchema = t.Object({
	q: t.String({ minLength: 1 }),
	limit: optionalBoundedListLimitSchema(DEFAULT_SEARCH_LIMIT),
});

export const SearchResultSchema = t.Object({
	id: t.Number(),
	crawlId: t.String(),
	url: t.String(),
	title: t.String(),
	description: t.String(),
	domain: t.String(),
	crawledAt: t.String({ format: "date-time" }),
	wordCount: t.Nullable(t.Number()),
	qualityScore: t.Nullable(t.Number()),
	titleHighlight: t.String(),
	snippet: t.String(),
});

export const SearchResponseSchema = t.Object({
	query: t.String(),
	count: t.Number(),
	results: t.Array(SearchResultSchema),
});

export type SearchResult = typeof SearchResultSchema.static;

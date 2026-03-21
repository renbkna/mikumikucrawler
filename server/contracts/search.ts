import { t } from "elysia";

export const SearchQuerySchema = t.Object({
	q: t.String({ minLength: 1 }),
	limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
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

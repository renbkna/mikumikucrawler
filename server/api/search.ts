import { Elysia } from "elysia";
import { API_PATHS } from "../../shared/contracts/index.js";
import { ApiErrorSchema } from "../contracts/errors.js";
import {
	DEFAULT_SEARCH_LIMIT,
	SearchQuerySchema,
	SearchResponseSchema,
} from "../contracts/search.js";
import { routeServices } from "./context.js";

function buildFtsQuery(query: string): string | null {
	const terms = query
		.trim()
		.split(/\s+/)
		.map((term) => term.replace(/"/g, '""'))
		.filter(Boolean);

	if (terms.length === 0) {
		return null;
	}

	return terms.map((term) => `"${term}"*`).join(" ");
}

export function searchApi() {
	return new Elysia({ name: "search-api", prefix: API_PATHS.root }).get(
		API_PATHS.search.slice(API_PATHS.root.length),
		(context) => {
			const { query, repos } = routeServices<{
				query: typeof SearchQuerySchema.static;
			}>(context);
			const ftsQuery = buildFtsQuery(query.q);
			if (!ftsQuery) {
				return {
					query: query.q,
					count: 0,
					results: [],
				};
			}

			const results = repos.search.search(
				ftsQuery,
				query.limit ?? DEFAULT_SEARCH_LIMIT,
			);
			const count = repos.search.count(ftsQuery);
			return {
				query: query.q,
				count,
				results,
			};
		},
		{
			query: SearchQuerySchema,
			response: {
				200: SearchResponseSchema,
				422: ApiErrorSchema,
				500: ApiErrorSchema,
			},
			detail: {
				tags: ["Search"],
				summary: "Search stored pages",
			},
		},
	);
}

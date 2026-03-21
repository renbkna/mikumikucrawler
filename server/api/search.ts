import { Elysia } from "elysia";
import { ApiErrorSchema } from "../contracts/errors.js";
import type { SearchResult } from "../contracts/search.js";
import {
	SearchQuerySchema,
	SearchResponseSchema,
} from "../contracts/search.js";
import type { StorageRepos } from "../storage/db.js";

export function searchApi(repos: StorageRepos) {
	return new Elysia({ name: "search-api", prefix: "/api" }).get(
		"/search",
		({ query }) => {
			const escaped = query.q.replace(/"/g, '""');
			const ftsQuery = `"${escaped}"*`;
			const results = repos.search.search(
				ftsQuery,
				query.limit ?? 20,
			) as SearchResult[];
			return {
				query: query.q,
				count: results.length,
				results,
			};
		},
		{
			query: SearchQuerySchema,
			response: {
				200: SearchResponseSchema,
				500: ApiErrorSchema,
			},
			detail: {
				tags: ["Search"],
				summary: "Search stored pages",
			},
		},
	);
}

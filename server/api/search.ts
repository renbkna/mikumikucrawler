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
		({ query, set }) => {
			const escaped = query.q.replace(/"/g, '""');
			const ftsQuery = `"${escaped}"*`;

			try {
				const results = repos.search.search(
					ftsQuery,
					query.limit ?? 20,
				) as SearchResult[];
				return {
					query: query.q,
					count: results.length,
					results,
				};
			} catch (error) {
				set.status = 500;
				return {
					error:
						error instanceof Error ? error.message : "Search request failed",
				};
			}
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

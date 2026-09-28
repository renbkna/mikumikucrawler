import { Elysia } from "elysia";
import { API_PATHS } from "../../shared/contracts/index.js";
import { ApiErrorSchema } from "../contracts/errors.js";
import {
	DEFAULT_SEARCH_LIMIT,
	SearchQuerySchema,
	SearchResponseSchema,
} from "../contracts/search.js";
import type { RouteServicesPlugin } from "./context.js";

export function searchApi(services: RouteServicesPlugin) {
	return new Elysia({ name: "search-api", prefix: API_PATHS.root }).use(services).get(
		API_PATHS.search.slice(API_PATHS.root.length),
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
		({ query, repos }) => ({
			crawlId: query.crawlId,
			query: query.q,
			...repos.search.search(query.crawlId, query.q, query.limit ?? DEFAULT_SEARCH_LIMIT),
		}),
	);
}

import { Elysia } from "elysia";
import { API_PATHS, PAGE_ROUTE_SEGMENTS } from "../../shared/contracts/api.js";
import { ApiErrorSchema } from "../contracts/errors.js";
import {
	PageContentParamsSchema,
	PageContentResponseSchema,
} from "../contracts/page.js";
import { routeServices } from "./context.js";

export function pagesApi() {
	return new Elysia({ name: "pages-api", prefix: API_PATHS.pages }).get(
		PAGE_ROUTE_SEGMENTS.content,
		(context) => {
			const { params, repos, set } = routeServices<{
				params: { id: number };
			}>(context);
			const content = repos.pages.getContentById(params.id);
			if (content === undefined) {
				set.status = 404;
				return { error: "Page not found" };
			}

			return {
				status: "ok",
				content,
			};
		},
		{
			params: PageContentParamsSchema,
			response: {
				200: PageContentResponseSchema,
				404: ApiErrorSchema,
				422: ApiErrorSchema,
			},
			detail: {
				tags: ["Pages"],
				summary: "Fetch stored page content",
			},
		},
	);
}

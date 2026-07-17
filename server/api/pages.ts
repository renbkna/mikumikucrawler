import { Elysia, t } from "elysia";
import { API_PATHS, PAGE_ROUTE_SEGMENTS } from "../../shared/contracts/index.js";
import { PageContentResponseSchema } from "../../shared/contracts/schemas.js";
import { ApiErrorSchema } from "../contracts/errors.js";
import { PositiveIntegerIdSchema } from "../contracts/http.js";
import type { RouteServicesPlugin } from "./context.js";

const PageContentParamsSchema = t.Object({
	id: PositiveIntegerIdSchema,
});

export function pagesApi(services: RouteServicesPlugin) {
	return new Elysia({ name: "pages-api", prefix: API_PATHS.pages }).use(services).get(
		PAGE_ROUTE_SEGMENTS.content,
		({ params, repos, status }) => {
			const content = repos.pages.getContentById(params.id);
			if (content === undefined) {
				return status(404, { error: "Page not found" });
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

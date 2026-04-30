import { Elysia } from "elysia";
import { ApiErrorSchema } from "../contracts/errors.js";
import {
	PageContentParamsSchema,
	PageContentResponseSchema,
} from "../contracts/page.js";
import { routeServices } from "./context.js";

export function pagesApi() {
	return new Elysia({ name: "pages-api", prefix: "/api/pages" }).get(
		"/:id/content",
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
				content: content ?? "",
			};
		},
		{
			params: PageContentParamsSchema,
			response: {
				200: PageContentResponseSchema,
				404: ApiErrorSchema,
			},
			detail: {
				tags: ["Pages"],
				summary: "Fetch stored page content",
			},
		},
	);
}

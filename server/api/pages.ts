import { Elysia } from "elysia";
import { ApiErrorSchema } from "../contracts/errors.js";
import {
	PageContentParamsSchema,
	PageContentResponseSchema,
} from "../contracts/page.js";
import type { StorageRepos } from "../storage/db.js";

export function pagesApi() {
	return new Elysia({ name: "pages-api", prefix: "/api/pages" }).get(
		"/:id/content",
		(context) => {
			const { params, repos, set } = context as typeof context & {
				params: { id: number };
				repos: StorageRepos;
			};
			const content = repos.pages.getContentById(params.id);
			if (content === null) {
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
			},
			detail: {
				tags: ["Pages"],
				summary: "Fetch stored page content",
			},
		},
	);
}

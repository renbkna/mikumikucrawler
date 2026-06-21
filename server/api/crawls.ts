import { Elysia, t } from "elysia";
import {
	API_PATHS,
	CRAWL_ROUTE_SEGMENTS,
	type CrawlStatus,
	DEFAULT_CRAWL_LIST_LIMIT,
} from "../../shared/contracts/index.js";
import {
	CrawlIdParamsSchema,
	CrawlListQuerySchema,
	CrawlListResponseSchema,
	CreateCrawlBodySchema,
	CreateCrawlResponseSchema,
	ExportQuerySchema,
	GetCrawlResponseSchema,
	ResumableCrawlListQuerySchema,
	ResumableCrawlListResponseSchema,
	ResumeCrawlResponseSchema,
	StopCrawlBodySchema,
	StopCrawlResponseSchema,
} from "../../shared/contracts/schemas.js";
import { validatePublicHttpUrl } from "../../shared/url.js";
import { config } from "../config/env.js";
import { ApiErrorSchema } from "../contracts/errors.js";
import { OkResponseSchema } from "../contracts/http.js";
import { exportPages } from "../domain/export/CrawlExportService.js";
import { routeServices } from "./context.js";

export function crawlsApi() {
	const crawlByIdRoutes = new Elysia().guard(
		{
			params: CrawlIdParamsSchema,
		},
		(app) =>
			app
				.post(
					CRAWL_ROUTE_SEGMENTS.stop,
					async (context) => {
						const { body, crawlManager, params, set } = routeServices<{
							body: typeof StopCrawlBodySchema.static;
						}>(context);
						const result = await crawlManager.stop(params.id, body?.mode);
						if (result.type === "not-found") {
							set.status = 404;
							return { error: "Crawl not found" };
						}
						if (result.type === "not-active") {
							set.status = 409;
							return { error: "Only active crawls can be stopped" };
						}
						return result.crawl;
					},
					{
						body: StopCrawlBodySchema,
						response: {
							200: StopCrawlResponseSchema,
							404: ApiErrorSchema,
							409: ApiErrorSchema,
							422: ApiErrorSchema,
						},
						detail: {
							tags: ["Crawls"],
							summary: "Request crawl pause or force stop",
						},
					},
				)
				.post(
					CRAWL_ROUTE_SEGMENTS.resume,
					(context) => {
						const { crawlManager, params, set } = routeServices(context);
						const result = crawlManager.resume(params.id);
						if (result.type === "not-found") {
							set.status = 404;
							return { error: "Crawl not found" };
						}

						if (result.type === "not-resumable") {
							set.status = 409;
							return {
								error: "Only paused or interrupted crawls can be resumed",
							};
						}

						if (result.type === "already-running") {
							set.status = 409;
							return { error: "Crawl is already running" };
						}

						return result.crawl;
					},
					{
						response: {
							200: ResumeCrawlResponseSchema,
							404: ApiErrorSchema,
							409: ApiErrorSchema,
							422: ApiErrorSchema,
						},
						detail: {
							tags: ["Crawls"],
							summary: "Resume a paused or interrupted crawl",
						},
					},
				)
				.get(
					CRAWL_ROUTE_SEGMENTS.byId,
					(context) => {
						const { crawlManager, params, set } = routeServices(context);
						const crawl = crawlManager.get(params.id);
						if (!crawl) {
							set.status = 404;
							return { error: "Crawl not found" };
						}
						return crawl;
					},
					{
						response: {
							200: GetCrawlResponseSchema,
							404: ApiErrorSchema,
							422: ApiErrorSchema,
						},
						detail: {
							tags: ["Crawls"],
							summary: "Get crawl state",
						},
					},
				)
				.get(
					CRAWL_ROUTE_SEGMENTS.export,
					(context) => {
						const { crawlManager, params, query, repos, set } = routeServices<{
							query: typeof ExportQuerySchema.static;
						}>(context);
						const crawl = crawlManager.get(params.id);
						if (!crawl) {
							set.status = 404;
							return { error: "Crawl not found" };
						}

						const pages = repos.pages.listForExport(params.id);
						const exported = exportPages(params.id, pages, query.format ?? "json");
						set.headers["content-type"] = exported.contentType;
						set.headers["content-disposition"] = exported.contentDisposition;
						return exported.body;
					},
					{
						query: ExportQuerySchema,
						response: {
							200: t.String(),
							404: ApiErrorSchema,
							422: ApiErrorSchema,
						},
						detail: {
							tags: ["Crawls"],
							summary: "Export crawl pages",
						},
					},
				)
				.delete(
					CRAWL_ROUTE_SEGMENTS.byId,
					(context) => {
						const { crawlManager, params, set } = routeServices(context);
						const result = crawlManager.delete(params.id);
						if (result.type === "not-found") {
							set.status = 404;
							return { error: "Crawl not found" };
						}
						if (result.type === "active") {
							set.status = 409;
							return { error: "Active crawls cannot be deleted" };
						}
						return { status: "ok" };
					},
					{
						response: {
							200: OkResponseSchema,
							404: ApiErrorSchema,
							409: ApiErrorSchema,
							422: ApiErrorSchema,
						},
						detail: {
							tags: ["Crawls"],
							summary: "Delete a stored crawl run",
						},
					},
				),
	);

	return new Elysia({ name: "crawls-api", prefix: API_PATHS.crawls })
		.post(
			CRAWL_ROUTE_SEGMENTS.collection,
			(context) => {
				const { body, crawlManager, set } = routeServices<{
					body: typeof CreateCrawlBodySchema.static;
				}>(context);
				const normalizedTarget = validatePublicHttpUrl(body.target, {
					allowLocalhost: !config.isProduction,
				});
				if ("error" in normalizedTarget) {
					set.status = 422;
					return { error: normalizedTarget.error, code: "INVALID_TARGET" };
				}

				return crawlManager.create({
					...body,
					target: normalizedTarget.url,
				});
			},
			{
				body: CreateCrawlBodySchema,
				response: {
					200: CreateCrawlResponseSchema,
					422: ApiErrorSchema,
				},
				detail: {
					tags: ["Crawls"],
					summary: "Create a crawl run",
				},
			},
		)
		.get(
			CRAWL_ROUTE_SEGMENTS.resumable,
			(context) => {
				const { crawlManager, query } = routeServices<{
					query: typeof ResumableCrawlListQuerySchema.static;
				}>(context);
				return {
					crawls: crawlManager.listResumable(query.limit ?? DEFAULT_CRAWL_LIST_LIMIT),
				};
			},
			{
				query: ResumableCrawlListQuerySchema,
				response: {
					200: ResumableCrawlListResponseSchema,
					422: ApiErrorSchema,
				},
				detail: {
					tags: ["Crawls"],
					summary: "List resumable crawl runs",
				},
			},
		)
		.get(
			CRAWL_ROUTE_SEGMENTS.collection,
			(context) => {
				const { crawlManager, query } = routeServices<{
					query: {
						status?: CrawlStatus;
						from?: string;
						to?: string;
						limit?: number;
					};
				}>(context);

				const listFilter: {
					status?: CrawlStatus;
					from?: string;
					to?: string;
					limit?: number;
				} = {};
				if (query.status !== undefined) {
					listFilter.status = query.status;
				}
				if (query.from !== undefined) {
					listFilter.from = query.from;
				}
				if (query.to !== undefined) {
					listFilter.to = query.to;
				}
				listFilter.limit = query.limit ?? DEFAULT_CRAWL_LIST_LIMIT;
				return {
					crawls: crawlManager.list({
						...listFilter,
					}),
				};
			},
			{
				query: CrawlListQuerySchema,
				response: {
					200: CrawlListResponseSchema,
					422: ApiErrorSchema,
				},
				detail: {
					tags: ["Crawls"],
					summary: "List crawl runs",
				},
			},
		)
		.use(crawlByIdRoutes);
}

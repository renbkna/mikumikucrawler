import { Elysia, t } from "elysia";
import { DeleteCrawlResponseSchema } from "../../shared/contracts/http.js";
import {
	API_PATHS,
	CRAWL_ROUTE_SEGMENTS,
	type CrawlRecoverySnapshot,
	type CrawlSummary,
	DEFAULT_CRAWL_LIST_LIMIT,
	isCrawlOptions,
} from "../../shared/contracts/index.js";
import {
	CrawlIdParamsSchema,
	CrawlListResponseSchema,
	CrawlPagesResponseSchema,
	CrawlRecoverySnapshotSchema,
	CreateCrawlBodySchema,
	CreateCrawlResponseSchema,
	ExportQuerySchema,
	GetCrawlResponseSchema,
	PageContentResponseSchema,
	ResumableCrawlListResponseSchema,
	StopCrawlBodySchema,
	StopCrawlResponseSchema,
} from "../../shared/contracts/schemas.js";
import { validatePublicHttpUrl } from "../../shared/url.js";
import { config } from "../config/env.js";
import { CrawlListQuerySchema, ResumableCrawlListQuerySchema } from "../contracts/crawls.js";
import { ApiErrorSchema } from "../contracts/errors.js";
import { PositiveIntegerIdSchema } from "../contracts/http.js";
import { createCrawlExportResponse } from "../domain/export/CrawlExportService.js";
import {
	CrawlIdentityConflictError,
	CrawlManagerClosingError,
	CrawlRuntimeCapacityError,
	type ResumeCrawlResult,
} from "../runtime/CrawlManager.js";
import { DurableStorageCapacityError } from "../storage/DurableStorageBudget.js";
import type { StorageRepos } from "../storage/db.js";
import type { RouteServicesPlugin } from "./context.js";

const CRAWL_SERVICE_CLOSING_ERROR = {
	error: "Crawl service is shutting down",
	code: "SERVICE_CLOSING",
} as const;

const CrawlPageContentParamsSchema = t.Object({
	id: CrawlIdParamsSchema.properties.id,
	pageId: PositiveIntegerIdSchema,
});

function createCrawlRecoverySnapshot(
	crawl: CrawlSummary,
	repos: Pick<StorageRepos, "pages">,
): CrawlRecoverySnapshot {
	const pageSnapshot = repos.pages.listSnapshot(crawl.id);
	return {
		crawl,
		pages: pageSnapshot.pages,
		pageCount: pageSnapshot.count,
	};
}

export function crawlsApi(services: RouteServicesPlugin) {
	const crawlByIdRoutes = new Elysia()
		.use(services)
		.guard({ schema: "merge", params: CrawlIdParamsSchema }, (app) =>
			app
				.get(
					CRAWL_ROUTE_SEGMENTS.pageContent,
					{
						params: CrawlPageContentParamsSchema,
						response: {
							200: PageContentResponseSchema,
							404: ApiErrorSchema,
							422: ApiErrorSchema,
						},
						detail: {
							tags: ["Crawls"],
							summary: "Fetch stored page content owned by a crawl",
						},
					},
					({ crawlManager, params, repos, status }) => {
						if (!crawlManager.get(params.id)) {
							return status(404, { error: "Crawl not found" });
						}
						const content = repos.pages.getContentById(params.id, params.pageId);
						if (content === undefined) {
							return status(404, { error: "Page not found for crawl" });
						}
						return { status: "ok", content };
					},
				)
				.post(
					CRAWL_ROUTE_SEGMENTS.stop,
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
					async ({ body, crawlManager, params, status }) => {
						const result = await crawlManager.stop(params.id, body?.mode);
						if (result.type === "not-found") {
							return status(404, { error: "Crawl not found" });
						}
						if (result.type === "not-active") {
							return status(409, { error: "Only active crawls can be stopped" });
						}
						return result.crawl;
					},
				)
				.post(
					CRAWL_ROUTE_SEGMENTS.resume,
					{
						response: {
							200: CrawlRecoverySnapshotSchema,
							404: ApiErrorSchema,
							409: ApiErrorSchema,
							422: ApiErrorSchema,
							503: ApiErrorSchema,
							507: ApiErrorSchema,
						},
						detail: {
							tags: ["Crawls"],
							summary: "Resume a paused or interrupted crawl",
						},
					},
					({ crawlManager, params, repos, status }) => {
						let result: ResumeCrawlResult;
						try {
							result = crawlManager.resume(params.id);
						} catch (error) {
							if (error instanceof CrawlManagerClosingError) {
								return status(503, CRAWL_SERVICE_CLOSING_ERROR);
							}
							if (error instanceof CrawlRuntimeCapacityError) {
								return status(503, {
									error: error.message,
									code: "RUNTIME_CAPACITY_REACHED",
								});
							}
							if (error instanceof DurableStorageCapacityError) {
								return status(507, {
									error: error.message,
									code: "STORAGE_CAPACITY_EXHAUSTED",
								});
							}
							throw error;
						}
						if (result.type === "not-found") {
							return status(404, { error: "Crawl not found" });
						}

						if (result.type === "not-resumable") {
							return status(409, {
								error: "Only paused or interrupted crawls can be resumed",
							});
						}

						if (result.type === "already-active") {
							return status(409, { error: "Crawl is already running" });
						}

						return createCrawlRecoverySnapshot(result.crawl, repos);
					},
				)
				.get(
					CRAWL_ROUTE_SEGMENTS.snapshot,
					{
						response: {
							200: CrawlRecoverySnapshotSchema,
							404: ApiErrorSchema,
							422: ApiErrorSchema,
						},
						detail: {
							tags: ["Crawls"],
							summary: "Recover crawl lifecycle and durable page state",
						},
					},
					({ crawlManager, params, repos, status }) => {
						const crawl = crawlManager.get(params.id);
						if (!crawl) {
							return status(404, { error: "Crawl not found" });
						}
						return createCrawlRecoverySnapshot(crawl, repos);
					},
				)
				.get(
					CRAWL_ROUTE_SEGMENTS.pages,
					{
						response: {
							200: CrawlPagesResponseSchema,
							404: ApiErrorSchema,
							422: ApiErrorSchema,
						},
						detail: {
							tags: ["Crawls"],
							summary: "List latest durable page summaries and the total stored count",
						},
					},
					({ crawlManager, params, repos, status }) => {
						if (!crawlManager.get(params.id)) {
							return status(404, { error: "Crawl not found" });
						}
						return repos.pages.listSnapshot(params.id);
					},
				)
				.get(
					CRAWL_ROUTE_SEGMENTS.byId,
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
					({ crawlManager, params, status }) => {
						const crawl = crawlManager.get(params.id);
						if (!crawl) {
							return status(404, { error: "Crawl not found" });
						}
						return crawl;
					},
				)
				.get(
					CRAWL_ROUTE_SEGMENTS.export,
					{
						query: ExportQuerySchema,
						response: {
							404: ApiErrorSchema,
							422: ApiErrorSchema,
						},
						detail: {
							tags: ["Crawls"],
							summary: "Export crawl pages",
						},
					},
					({ crawlManager, params, query, repos, status }) => {
						const crawl = crawlManager.get(params.id);
						if (!crawl) {
							return status(404, { error: "Crawl not found" });
						}

						const format = query.format ?? "json";
						const pages = repos.pages.iterateForExport(params.id, {
							includeContent: format === "json",
						});
						return createCrawlExportResponse(params.id, pages, format);
					},
				)
				.delete(
					CRAWL_ROUTE_SEGMENTS.byId,
					{
						response: {
							200: DeleteCrawlResponseSchema,
							409: ApiErrorSchema,
							422: ApiErrorSchema,
						},
						detail: {
							tags: ["Crawls"],
							summary: "Delete a stored crawl run",
						},
					},
					({ crawlManager, params, status }) => {
						const result = crawlManager.delete(params.id);
						if (result.type === "not-found") {
							return { status: "ok", outcome: "already-absent" } as const;
						}
						if (result.type === "active") {
							return status(409, { error: "Active crawls cannot be deleted" });
						}
						return { status: "ok", outcome: "deleted" } as const;
					},
				),
		);

	return new Elysia({ name: "crawls-api", prefix: API_PATHS.crawls })
		.use(services)
		.post(
			CRAWL_ROUTE_SEGMENTS.collection,
			{
				body: CreateCrawlBodySchema,
				response: {
					200: CreateCrawlResponseSchema,
					409: ApiErrorSchema,
					422: ApiErrorSchema,
					503: ApiErrorSchema,
					507: ApiErrorSchema,
				},
				detail: {
					tags: ["Crawls"],
					summary: "Create a crawl run",
				},
			},
			({ body, crawlManager, status }) => {
				const normalizedTarget = validatePublicHttpUrl(body.options.target, {
					allowLocalhost: config.allowLocalhostTargets,
				});
				if ("error" in normalizedTarget) {
					return status(422, { error: normalizedTarget.error, code: "INVALID_TARGET" });
				}
				const normalizedOptions = {
					...body.options,
					target: normalizedTarget.url,
				};
				if (!isCrawlOptions(normalizedOptions)) {
					return status(422, {
						error: "Crawl options contain an unsupported combination",
						code: "INVALID_CRAWL_OPTIONS",
					});
				}

				try {
					return crawlManager.create(body.id, normalizedOptions);
				} catch (error) {
					if (error instanceof CrawlIdentityConflictError) {
						return status(409, {
							error: error.message,
							code: "CRAWL_IDENTITY_CONFLICT",
						});
					}
					if (error instanceof CrawlManagerClosingError) {
						return status(503, CRAWL_SERVICE_CLOSING_ERROR);
					}
					if (error instanceof CrawlRuntimeCapacityError) {
						return status(503, {
							error: error.message,
							code: "RUNTIME_CAPACITY_REACHED",
						});
					}
					if (error instanceof DurableStorageCapacityError) {
						return status(507, {
							error: error.message,
							code: "STORAGE_CAPACITY_EXHAUSTED",
						});
					}
					throw error;
				}
			},
		)
		.get(
			CRAWL_ROUTE_SEGMENTS.resumable,
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
			({ crawlManager, query }) => {
				return {
					crawls: crawlManager.listResumable(query.limit ?? DEFAULT_CRAWL_LIST_LIMIT),
				};
			},
		)
		.get(
			CRAWL_ROUTE_SEGMENTS.collection,
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
			({ crawlManager, query }) => {
				return {
					crawls: crawlManager.list({
						...query,
						limit: query.limit ?? DEFAULT_CRAWL_LIST_LIMIT,
					}),
				};
			},
		)
		.use(crawlByIdRoutes);
}

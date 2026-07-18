import { Elysia, t } from "elysia";
import {
	API_PATHS,
	CRAWL_ROUTE_SEGMENTS,
	type CrawlRecoverySnapshot,
	type CrawlStatus,
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
	ResumableCrawlListResponseSchema,
	StopCrawlBodySchema,
	StopCrawlResponseSchema,
} from "../../shared/contracts/schemas.js";
import { validatePublicHttpUrl } from "../../shared/url.js";
import { config } from "../config/env.js";
import { CrawlListQuerySchema, ResumableCrawlListQuerySchema } from "../contracts/crawls.js";
import { ApiErrorSchema } from "../contracts/errors.js";
import { OkResponseSchema } from "../contracts/http.js";
import { createCrawlExportResponse } from "../domain/export/CrawlExportService.js";
import { CrawlManagerClosingError, type ResumeCrawlResult } from "../runtime/CrawlManager.js";
import type { StorageRepos } from "../storage/db.js";
import type { RouteServicesPlugin } from "./context.js";

const CRAWL_SERVICE_CLOSING_ERROR = {
	error: "Crawl service is shutting down",
	code: "SERVICE_CLOSING",
} as const;

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
	const crawlByIdRoutes = new Elysia().use(services).guard(
		{
			params: CrawlIdParamsSchema,
		},
		(app) =>
			app
				.post(
					CRAWL_ROUTE_SEGMENTS.stop,
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
					({ crawlManager, params, repos, status }) => {
						let result: ResumeCrawlResult;
						try {
							result = crawlManager.resume(params.id);
						} catch (error) {
							if (error instanceof CrawlManagerClosingError) {
								return status(503, CRAWL_SERVICE_CLOSING_ERROR);
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

						if (result.type === "already-running") {
							return status(409, { error: "Crawl is already running" });
						}

						return createCrawlRecoverySnapshot(result.crawl, repos);
					},
					{
						response: {
							200: CrawlRecoverySnapshotSchema,
							404: ApiErrorSchema,
							409: ApiErrorSchema,
							422: ApiErrorSchema,
							503: ApiErrorSchema,
						},
						detail: {
							tags: ["Crawls"],
							summary: "Resume a paused or interrupted crawl",
						},
					},
				)
				.get(
					CRAWL_ROUTE_SEGMENTS.snapshot,
					({ crawlManager, params, repos, status }) => {
						const crawl = crawlManager.get(params.id);
						if (!crawl) {
							return status(404, { error: "Crawl not found" });
						}
						return createCrawlRecoverySnapshot(crawl, repos);
					},
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
				)
				.get(
					CRAWL_ROUTE_SEGMENTS.pages,
					({ crawlManager, params, repos, status }) => {
						if (!crawlManager.get(params.id)) {
							return status(404, { error: "Crawl not found" });
						}
						return repos.pages.listSnapshot(params.id);
					},
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
				)
				.get(
					CRAWL_ROUTE_SEGMENTS.byId,
					({ crawlManager, params, status }) => {
						const crawl = crawlManager.get(params.id);
						if (!crawl) {
							return status(404, { error: "Crawl not found" });
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
					({ crawlManager, params, status }) => {
						const result = crawlManager.delete(params.id);
						if (result.type === "not-found") {
							return status(404, { error: "Crawl not found" });
						}
						if (result.type === "active") {
							return status(409, { error: "Active crawls cannot be deleted" });
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
		.use(services)
		.post(
			CRAWL_ROUTE_SEGMENTS.collection,
			({ body, crawlManager, status }) => {
				const normalizedTarget = validatePublicHttpUrl(body.target, {
					allowLocalhost: config.allowLocalhostTargets,
				});
				if ("error" in normalizedTarget) {
					return status(422, { error: normalizedTarget.error, code: "INVALID_TARGET" });
				}
				const normalizedOptions = {
					...body,
					target: normalizedTarget.url,
				};
				if (!isCrawlOptions(normalizedOptions)) {
					return status(422, {
						error: "Crawl options contain an unsupported combination",
						code: "INVALID_CRAWL_OPTIONS",
					});
				}

				try {
					return crawlManager.create(normalizedOptions);
				} catch (error) {
					if (error instanceof CrawlManagerClosingError) {
						return status(503, CRAWL_SERVICE_CLOSING_ERROR);
					}
					throw error;
				}
			},
			{
				body: CreateCrawlBodySchema,
				response: {
					200: CreateCrawlResponseSchema,
					422: ApiErrorSchema,
					503: ApiErrorSchema,
				},
				detail: {
					tags: ["Crawls"],
					summary: "Create a crawl run",
				},
			},
		)
		.get(
			CRAWL_ROUTE_SEGMENTS.resumable,
			({ crawlManager, query }) => {
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
			({ crawlManager, query }) => {
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

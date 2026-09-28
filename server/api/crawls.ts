import { Elysia, status, t } from "elysia";
import { DeleteCrawlResponseSchema } from "../../shared/contracts/http.js";
import {
	API_PATHS,
	CRAWL_ROUTE_SEGMENTS,
	type CrawlRecoverySnapshot,
	type CrawlSummary,
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
import {
	CrawlListQuerySchema,
	DEFAULT_CRAWL_LIST_LIMIT,
	ResumableCrawlListQuerySchema,
} from "../contracts/crawls.js";
import { type ApiError, ApiErrorSchema } from "../contracts/errors.js";
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

const CRAWL_NOT_FOUND = { error: "Crawl not found" } as const;

const CrawlPageContentParamsSchema = t.Object({
	id: CrawlIdParamsSchema.properties.id,
	pageId: PositiveIntegerIdSchema,
});

/** The HTTP contract for failures to admit a crawl runtime; other errors are not admission outcomes. */
function admissionFailure(error: unknown) {
	if (error instanceof CrawlManagerClosingError) {
		return status(503, { error: error.message, code: "SERVICE_CLOSING" } satisfies ApiError);
	}
	if (error instanceof CrawlRuntimeCapacityError) {
		return status(503, {
			error: error.message,
			code: "RUNTIME_CAPACITY_REACHED",
		} satisfies ApiError);
	}
	if (error instanceof DurableStorageCapacityError) {
		return status(507, {
			error: error.message,
			code: "STORAGE_CAPACITY_EXHAUSTED",
		} satisfies ApiError);
	}
	return null;
}

function createCrawlRecoverySnapshot(
	crawl: CrawlSummary,
	repos: Pick<StorageRepos, "pages">,
): CrawlRecoverySnapshot {
	const pageSnapshot = repos.pages.listSnapshot(crawl.id);
	return { crawl, pages: pageSnapshot.pages, pageCount: pageSnapshot.count };
}

const crawlsTag = (summary: string) => ({ tags: ["Crawls"], summary });

export function crawlsApi(services: RouteServicesPlugin) {
	const existingCrawlRoutes = new Elysia()
		.use(services)
		.guard({ schema: "merge", params: CrawlIdParamsSchema }, (app) =>
			app
				.derive(({ crawlManager, params, status }) => {
					const crawl = crawlManager.get(params.id);
					return crawl ? { crawl } : status(404, CRAWL_NOT_FOUND);
				})
				.get(
					CRAWL_ROUTE_SEGMENTS.pageContent,
					{
						params: CrawlPageContentParamsSchema,
						response: { 200: PageContentResponseSchema, 404: ApiErrorSchema, 422: ApiErrorSchema },
						detail: crawlsTag("Fetch stored page content owned by a crawl"),
					},
					({ crawl, params, repos, status }) => {
						const content = repos.pages.getContentById(crawl.id, params.pageId);
						if (content === undefined) {
							return status(404, { error: "Page not found for crawl" });
						}
						return { status: "ok", content };
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
						detail: crawlsTag("Recover crawl lifecycle and durable page state"),
					},
					({ crawl, repos }) => createCrawlRecoverySnapshot(crawl, repos),
				)
				.get(
					CRAWL_ROUTE_SEGMENTS.pages,
					{
						response: { 200: CrawlPagesResponseSchema, 404: ApiErrorSchema, 422: ApiErrorSchema },
						detail: crawlsTag("List latest durable page summaries and the total stored count"),
					},
					({ crawl, repos }) => repos.pages.listSnapshot(crawl.id),
				)
				.get(
					CRAWL_ROUTE_SEGMENTS.byId,
					{
						response: { 200: GetCrawlResponseSchema, 404: ApiErrorSchema, 422: ApiErrorSchema },
						detail: crawlsTag("Get crawl state"),
					},
					({ crawl }) => crawl,
				)
				.get(
					CRAWL_ROUTE_SEGMENTS.export,
					{
						query: ExportQuerySchema,
						response: { 404: ApiErrorSchema, 422: ApiErrorSchema },
						detail: crawlsTag("Export crawl pages"),
					},
					({ crawl, query, repos }) => {
						const format = query.format ?? "json";
						const pages = repos.pages.iterateForExport(crawl.id, {
							includeContent: format === "json",
						});
						return createCrawlExportResponse(crawl.id, pages, format);
					},
				),
		);

	const crawlCommandRoutes = new Elysia()
		.use(services)
		.guard({ schema: "merge", params: CrawlIdParamsSchema }, (app) =>
			app
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
						detail: crawlsTag("Request crawl pause or force stop"),
					},
					async ({ body, crawlManager, params, status }) => {
						const result = await crawlManager.stop(params.id, body?.mode);
						if (result.type === "not-found") return status(404, CRAWL_NOT_FOUND);
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
						detail: crawlsTag("Resume a paused or interrupted crawl"),
					},
					({ crawlManager, params, repos, status }) => {
						let result: ResumeCrawlResult;
						try {
							result = crawlManager.resume(params.id);
						} catch (error) {
							const failure = admissionFailure(error);
							if (!failure) throw error;
							return failure;
						}
						if (result.type === "not-found") return status(404, CRAWL_NOT_FOUND);
						if (result.type === "not-resumable") {
							return status(409, { error: "Only paused or interrupted crawls can be resumed" });
						}
						if (result.type === "already-active") {
							return status(409, { error: "Crawl is already running" });
						}
						return createCrawlRecoverySnapshot(result.crawl, repos);
					},
				)
				.delete(
					CRAWL_ROUTE_SEGMENTS.byId,
					{
						response: { 200: DeleteCrawlResponseSchema, 409: ApiErrorSchema, 422: ApiErrorSchema },
						detail: crawlsTag("Delete a stored crawl run"),
					},
					({ crawlManager, params, status }) => {
						const result = crawlManager.delete(params.id);
						if (result.type === "active") {
							return status(409, { error: "Active crawls cannot be deleted" });
						}
						return {
							status: "ok",
							outcome: result.type === "not-found" ? "already-absent" : "deleted",
						} as const;
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
				detail: crawlsTag("Create a crawl run"),
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
						return status(409, { error: error.message, code: "CRAWL_IDENTITY_CONFLICT" });
					}
					const failure = admissionFailure(error);
					if (!failure) throw error;
					return failure;
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
				detail: crawlsTag("List resumable crawl runs"),
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
				detail: crawlsTag("List crawl runs"),
			},
			({ crawlManager, query }) => {
				return {
					crawls: crawlManager.list({ ...query, limit: query.limit ?? DEFAULT_CRAWL_LIST_LIMIT }),
				};
			},
		)
		.use(crawlCommandRoutes)
		.use(existingCrawlRoutes);
}

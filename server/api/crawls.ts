import { Elysia, t } from "elysia";
import type { CrawlStatus } from "../contracts/crawl.js";
import {
	CrawlIdParamsSchema,
	CrawlListQuerySchema,
	CrawlListResponseSchema,
	CreateCrawlBodySchema,
	CreateCrawlResponseSchema,
	DeleteCrawlResponseSchema,
	ExportQuerySchema,
	GetCrawlResponseSchema,
	ResumeCrawlResponseSchema,
	StopCrawlResponseSchema,
} from "../contracts/crawl.js";
import { ApiErrorSchema } from "../contracts/errors.js";
import { routeServices } from "./context.js";
import { normalizeHttpUrl } from "../../shared/url.js";

const CSV_INJECTION_PREFIX = /^[=+\-@|\t]/;

function escapeCsvCell(value: string | null | undefined): string {
	const raw = value ?? "";
	const sanitized = CSV_INJECTION_PREFIX.test(raw) ? `'${raw}` : raw;
	return `"${sanitized.replaceAll('"', '""')}"`;
}

export function crawlsApi() {
	const crawlByIdRoutes = new Elysia().guard(
		{
			params: CrawlIdParamsSchema,
		},
		(app) =>
			app
				.post(
					"/:id/stop",
					(context) => {
						const { crawlManager, params, set } = routeServices(context);
						const crawl = crawlManager.stop(params.id);
						if (!crawl) {
							set.status = 404;
							return { error: "Crawl not found" };
						}
						return crawl;
					},
					{
						response: {
							200: StopCrawlResponseSchema,
							404: ApiErrorSchema,
						},
						detail: {
							tags: ["Crawls"],
							summary: "Request graceful crawl stop",
						},
					},
				)
				.post(
					"/:id/resume",
					(context) => {
						const { crawlManager, params, set } = routeServices(context);
						const crawl = crawlManager.resume(params.id);
						if (!crawlManager.get(params.id)) {
							set.status = 404;
							return { error: "Crawl not found" };
						}

						if (!crawl) {
							set.status = 409;
							return { error: "Only interrupted crawls can be resumed" };
						}

						return crawl;
					},
					{
						response: {
							200: ResumeCrawlResponseSchema,
							404: ApiErrorSchema,
							409: ApiErrorSchema,
						},
						detail: {
							tags: ["Crawls"],
							summary: "Resume an interrupted crawl",
						},
					},
				)
				.get(
					"/:id",
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
						},
						detail: {
							tags: ["Crawls"],
							summary: "Get crawl state",
						},
					},
				)
				.get(
					"/:id/export",
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
						const format = query.format ?? "json";
						const safeFilename = params.id.replace(/[^a-zA-Z0-9_-]/g, "_");

						if (format === "csv") {
							const rows = [
								[
									"id",
									"url",
									"title",
									"description",
									"contentType",
									"domain",
									"crawledAt",
								],
								...pages.map((page: (typeof pages)[number]) => [
									String(page.id),
									page.url,
									page.title,
									page.description,
									page.contentType,
									page.domain,
									page.crawledAt,
								]),
							];

							const csv = rows
								.map((row) =>
									row.map((cell: string) => escapeCsvCell(cell)).join(","),
								)
								.join("\n");

							set.headers["content-type"] = "text/csv; charset=utf-8";
							set.headers["content-disposition"] =
								`attachment; filename="${safeFilename}.csv"`;
							return csv;
						}

						set.headers["content-type"] = "application/json; charset=utf-8";
						set.headers["content-disposition"] =
							`attachment; filename="${safeFilename}.json"`;
						return JSON.stringify(pages, null, 2);
					},
					{
						query: ExportQuerySchema,
						response: {
							200: t.String(),
							404: ApiErrorSchema,
						},
						detail: {
							tags: ["Crawls"],
							summary: "Export crawl pages",
						},
					},
				)
				.delete(
					"/:id",
					(context) => {
						const { crawlManager, params, set } = routeServices(context);
						const deleted = crawlManager.delete(params.id);
						if (!crawlManager.get(params.id) && !deleted) {
							set.status = 404;
							return { error: "Crawl not found" };
						}
						if (!deleted) {
							set.status = 409;
							return { error: "Active crawls cannot be deleted" };
						}
						return { status: "ok" };
					},
					{
						response: {
							200: DeleteCrawlResponseSchema,
							404: ApiErrorSchema,
							409: ApiErrorSchema,
						},
						detail: {
							tags: ["Crawls"],
							summary: "Delete a stored crawl run",
						},
					},
				),
	);

	return new Elysia({ name: "crawls-api", prefix: "/api/crawls" })
		.post(
			"/",
			(context) => {
				const { body, crawlManager, set } = routeServices<{
					body: typeof CreateCrawlBodySchema.static;
				}>(context);
				const normalizedTarget = normalizeHttpUrl(body.target);
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
			"/",
			(context) => {
				const { crawlManager, query } = routeServices<{
					query: {
						status?: CrawlStatus;
						from?: string;
						to?: string;
						limit?: number;
					};
				}>(context);
				return {
					crawls: crawlManager.list({
						status: query.status,
						from: query.from,
						to: query.to,
						limit: query.limit ?? 25,
					}),
				};
			},
			{
				query: CrawlListQuerySchema,
				response: {
					200: CrawlListResponseSchema,
				},
				detail: {
					tags: ["Crawls"],
					summary: "List crawl runs",
				},
			},
		)
		.use(crawlByIdRoutes);
}

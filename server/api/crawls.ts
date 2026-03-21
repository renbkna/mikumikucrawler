import { Elysia } from "elysia";
import type { CrawlStatus } from "../contracts/crawl.js";
import {
	CrawlIdParamsSchema,
	CrawlListQuerySchema,
	CrawlListResponseSchema,
	CreateCrawlBodySchema,
	CreateCrawlResponseSchema,
	ExportQuerySchema,
	GetCrawlResponseSchema,
	ResumeCrawlResponseSchema,
	StopCrawlResponseSchema,
} from "../contracts/crawl.js";
import { ApiErrorSchema } from "../contracts/errors.js";
import type { CrawlManager } from "../runtime/CrawlManager.js";
import type { StorageRepos } from "../storage/db.js";

const CSV_INJECTION_PREFIX = /^[=+\-@|\t]/;

function escapeCsvCell(value: string | null | undefined): string {
	const raw = value ?? "";
	const sanitized = CSV_INJECTION_PREFIX.test(raw) ? `'${raw}` : raw;
	return `"${sanitized.replaceAll('"', '""')}"`;
}

interface CrawlsApiDependencies {
	crawlManager: CrawlManager;
	repos: StorageRepos;
}

export function crawlsApi({ crawlManager, repos }: CrawlsApiDependencies) {
	return new Elysia({ name: "crawls-api", prefix: "/api/crawls" })
		.post("/", ({ body }) => crawlManager.create(body), {
			body: CreateCrawlBodySchema,
			response: {
				200: CreateCrawlResponseSchema,
			},
			detail: {
				tags: ["Crawls"],
				summary: "Create a crawl run",
			},
		})
		.post(
			"/:id/stop",
			({ params, set }) => {
				const crawl = crawlManager.stop(params.id);
				if (!crawl) {
					set.status = 404;
					return { error: "Crawl not found" };
				}
				return crawl;
			},
			{
				params: CrawlIdParamsSchema,
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
			({ params, set }) => {
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
				params: CrawlIdParamsSchema,
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
			({ params, set }) => {
				const crawl = crawlManager.get(params.id);
				if (!crawl) {
					set.status = 404;
					return { error: "Crawl not found" };
				}
				return crawl;
			},
			{
				params: CrawlIdParamsSchema,
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
			"/",
			({ query }) => ({
				crawls: crawlManager.list({
					status: query.status as CrawlStatus | undefined,
					from: query.from,
					to: query.to,
					limit: query.limit ?? 25,
				}),
			}),
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
		.get(
			"/:id/export",
			({ params, query, set }) => {
				const crawl = crawlManager.get(params.id);
				if (!crawl) {
					set.status = 404;
					return { error: "Crawl not found" };
				}

				const pages = repos.pages.listForExport(params.id);
				const format = query.format ?? "json";

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
						`attachment; filename="${params.id}.csv"`;
					return csv;
				}

				set.headers["content-type"] = "application/json; charset=utf-8";
				set.headers["content-disposition"] =
					`attachment; filename="${params.id}.json"`;
				return JSON.stringify(pages, null, 2);
			},
			{
				params: CrawlIdParamsSchema,
				query: ExportQuerySchema,
				response: { 404: ApiErrorSchema },
				detail: {
					tags: ["Crawls"],
					summary: "Export crawl pages",
				},
			},
		)
		.delete(
			"/:id",
			({ params, set }) => {
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
				params: CrawlIdParamsSchema,
				response: { 404: ApiErrorSchema, 409: ApiErrorSchema },
				detail: {
					tags: ["Crawls"],
					summary: "Delete a stored crawl run",
				},
			},
		);
}

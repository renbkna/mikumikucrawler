import { describe, expect, test } from "bun:test";
import { createInMemoryStorage } from "../db.js";

describe("storage contract", () => {
	test("applies migrations and records them", () => {
		const storage = createInMemoryStorage();
		const rows = storage.db
			.query("SELECT id FROM schema_migrations ORDER BY id")
			.all() as Array<{ id: string }>;

		expect(rows.map((row) => row.id)).toEqual([
			"0001_crawl_runs.sql",
			"0002_queue_pages.sql",
			"0003_pages_fts.sql",
			"0004_runtime_persistence.sql",
		]);
	});

	test("queue items restore only for the requested crawlId", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun("crawl-a", "https://a.example", {
			target: "https://a.example",
			crawlMethod: "links",
			crawlDepth: 1,
			crawlDelay: 200,
			maxPages: 5,
			maxPagesPerDomain: 0,
			maxConcurrentRequests: 1,
			retryLimit: 0,
			dynamic: false,
			respectRobots: false,
			contentOnly: false,
			saveMedia: false,
		});
		storage.repos.crawlRuns.createRun("crawl-b", "https://b.example", {
			target: "https://b.example",
			crawlMethod: "links",
			crawlDepth: 1,
			crawlDelay: 200,
			maxPages: 5,
			maxPagesPerDomain: 0,
			maxConcurrentRequests: 1,
			retryLimit: 0,
			dynamic: false,
			respectRobots: false,
			contentOnly: false,
			saveMedia: false,
		});

		storage.repos.crawlQueue.enqueueMany("crawl-a", [
			{
				url: "https://a.example/one",
				domain: "a.example",
				depth: 1,
				retries: 0,
			},
		]);
		storage.repos.crawlQueue.enqueueMany("crawl-b", [
			{
				url: "https://b.example/two",
				domain: "b.example",
				depth: 1,
				retries: 0,
			},
		]);

		expect(storage.repos.crawlQueue.listPending("crawl-a")).toEqual([
			{
				url: "https://a.example/one",
				domain: "a.example",
				depth: 1,
				retries: 0,
				parentUrl: undefined,
				availableAt: 0,
			},
		]);
	});

	test("typed counters are read from columns without JSON reparsing", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun(
			"crawl-typed",
			"https://typed.example",
			{
				target: "https://typed.example",
				crawlMethod: "links",
				crawlDepth: 1,
				crawlDelay: 200,
				maxPages: 5,
				maxPagesPerDomain: 0,
				maxConcurrentRequests: 1,
				retryLimit: 0,
				dynamic: false,
				respectRobots: false,
				contentOnly: false,
				saveMedia: false,
			},
		);

		storage.repos.crawlRuns.markCompleted(
			"crawl-typed",
			{
				...created.counters,
				pagesScanned: 3,
				successCount: 2,
				failureCount: 1,
				skippedCount: 0,
				linksFound: 5,
				mediaFiles: 1,
				totalDataKb: 42,
			},
			null,
		);

		const loaded = storage.repos.crawlRuns.getById("crawl-typed");
		expect(loaded?.counters).toEqual({
			pagesScanned: 3,
			successCount: 2,
			failureCount: 1,
			skippedCount: 0,
			linksFound: 5,
			mediaFiles: 1,
			totalDataKb: 42,
		});
	});

	test("date filters accept API ISO timestamps without dropping matching rows", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun(
			"crawl-filter",
			"https://filter.example",
			{
				target: "https://filter.example",
				crawlMethod: "links",
				crawlDepth: 1,
				crawlDelay: 200,
				maxPages: 5,
				maxPagesPerDomain: 0,
				maxConcurrentRequests: 1,
				retryLimit: 0,
				dynamic: false,
				respectRobots: false,
				contentOnly: false,
				saveMedia: false,
			},
		);

		expect(
			storage.repos.crawlRuns
				.list({ from: created.createdAt })
				.map((run) => run.id),
		).toContain("crawl-filter");
	});

	test("export rows expose camelCase fields expected by the API layer", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun(
			"crawl-export",
			"https://export.example",
			{
				target: "https://export.example",
				crawlMethod: "links",
				crawlDepth: 1,
				crawlDelay: 200,
				maxPages: 5,
				maxPagesPerDomain: 0,
				maxConcurrentRequests: 1,
				retryLimit: 0,
				dynamic: false,
				respectRobots: false,
				contentOnly: false,
				saveMedia: false,
			},
		);

		storage.repos.pages.save({
			crawlId: created.id,
			url: "https://export.example/page",
			domain: "export.example",
			contentType: "text/html",
			statusCode: 200,
			contentLength: 123,
			title: "Exported page",
			description: "Export description",
			content: "Export body",
			isDynamic: false,
			lastModified: null,
			etag: null,
			processedContent: {
				extractedData: {},
				metadata: {},
				analysis: {},
				media: [],
				links: [],
				errors: [],
			},
			links: [],
		});

		const rows = storage.repos.pages.listForExport(created.id);
		const rawRow = rows[0] as unknown as Record<string, unknown>;
		expect(rows).toHaveLength(1);
		expect(rows[0].contentType).toBe("text/html");
		expect(typeof rows[0].crawledAt).toBe("string");
		expect(rows[0].crawledAt.length).toBeGreaterThan(0);
		expect(rawRow.content_type).toBeUndefined();
		expect(rawRow.crawled_at).toBeUndefined();
	});
});

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyMigrations, createInMemoryStorage } from "../db.js";

describe("storage contract", () => {
	test("applies migrations and records them", () => {
		const storage = createInMemoryStorage();
		const rows = storage.db
			.query("SELECT id, checksum FROM schema_migrations ORDER BY id")
			.all() as Array<{ id: string; checksum: string | null }>;

		expect(rows.map((row) => row.id)).toEqual([
			"0001_crawl_runs.sql",
			"0002_queue_pages.sql",
			"0003_pages_fts.sql",
			"0004_runtime_persistence.sql",
		]);
		expect(rows.every((row) => typeof row.checksum === "string")).toBe(true);
	});

	test("fails startup when an applied migration file changes", () => {
		const migrationDir = mkdtempSync(path.join(tmpdir(), "miku-migrations-"));
		const migrationPath = path.join(migrationDir, "0001_test.sql");
		writeFileSync(
			migrationPath,
			"CREATE TABLE test_table (id TEXT PRIMARY KEY);",
		);

		const db = new Database(":memory:");
		applyMigrations(db, migrationDir);

		writeFileSync(
			migrationPath,
			"CREATE TABLE test_table (id TEXT PRIMARY KEY, changed TEXT);",
		);

		expect(() => applyMigrations(db, migrationDir)).toThrow(
			"checksum mismatch",
		);
	});

	test("fails startup for legacy migration tables without checksum support", () => {
		const migrationDir = mkdtempSync(path.join(tmpdir(), "miku-migrations-"));
		writeFileSync(
			path.join(migrationDir, "0001_test.sql"),
			"CREATE TABLE test_table (id TEXT PRIMARY KEY);",
		);
		const db = new Database(":memory:");
		db.exec(`
			CREATE TABLE schema_migrations (
				id TEXT PRIMARY KEY,
				applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			);
			INSERT INTO schema_migrations (id) VALUES ('0001_test.sql');
		`);

		expect(() => applyMigrations(db, migrationDir)).toThrow("missing checksum");
	});

	test("fails startup for applied migration rows with null checksums", () => {
		const migrationDir = mkdtempSync(path.join(tmpdir(), "miku-migrations-"));
		writeFileSync(
			path.join(migrationDir, "0001_test.sql"),
			"CREATE TABLE test_table (id TEXT PRIMARY KEY);",
		);
		const db = new Database(":memory:");
		db.exec(`
			CREATE TABLE schema_migrations (
				id TEXT PRIMARY KEY,
				applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				checksum TEXT
			);
			INSERT INTO schema_migrations (id, checksum) VALUES ('0001_test.sql', NULL);
		`);

		expect(() => applyMigrations(db, migrationDir)).toThrow("has no checksum");
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

	test("item completion commits page, terminal, queue removal, counters, and event sequence atomically", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun("crawl-item", "https://item.example", {
			target: "https://item.example",
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
		storage.repos.crawlQueue.enqueueMany("crawl-item", [
			{
				url: "https://item.example/page",
				domain: "item.example",
				depth: 0,
				retries: 0,
				availableAt: 0,
			},
		]);

		const result = storage.repos.crawlItems.commitCompletedItem({
			crawlId: "crawl-item",
			url: "https://item.example/page",
			outcome: "success",
			page: {
				crawlId: "crawl-item",
				url: "https://item.example/page",
				domain: "item.example",
				contentType: "text/html",
				statusCode: 200,
				contentLength: 2048,
				title: "Item page",
				description: "Item description",
				content: "<main>Item</main>",
				isDynamic: false,
				lastModified: null,
				etag: null,
				processedContent: {
					extractedData: { mainContent: "Item" },
					metadata: {},
					analysis: {},
					media: [],
					links: [],
					errors: [],
				},
				links: [],
			},
			counters: {
				pagesScanned: 1,
				successCount: 1,
				failureCount: 0,
				skippedCount: 0,
				linksFound: 0,
				mediaFiles: 0,
				totalDataKb: 2,
			},
			eventSequence: 7,
		});

		expect(typeof result.pageId).toBe("number");
		expect(storage.repos.pages.listForExport("crawl-item")).toHaveLength(1);
		expect(storage.repos.crawlTerminals.listByCrawlId("crawl-item")).toEqual([
			{ url: "https://item.example/page", outcome: "success" },
		]);
		expect(storage.repos.crawlQueue.listPending("crawl-item")).toEqual([]);
		expect(storage.repos.crawlRuns.getById("crawl-item")?.eventSequence).toBe(
			7,
		);
	});

	test("item completion rolls back page save when terminal persistence fails", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun(
			"crawl-item-rollback",
			"https://rollback.example",
			{
				target: "https://rollback.example",
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

		expect(() =>
			storage.repos.crawlItems.commitCompletedItem({
				crawlId: "crawl-item-rollback",
				url: "https://rollback.example/page",
				outcome: "invalid" as never,
				page: {
					crawlId: "crawl-item-rollback",
					url: "https://rollback.example/page",
					domain: "rollback.example",
					contentType: "text/html",
					statusCode: 200,
					contentLength: 100,
					title: "Rollback page",
					description: "",
					content: "<main>Rollback</main>",
					isDynamic: false,
					lastModified: null,
					etag: null,
					processedContent: {
						extractedData: { mainContent: "Rollback" },
						metadata: {},
						analysis: {},
						media: [],
						links: [],
						errors: [],
					},
					links: [],
				},
				counters: {
					pagesScanned: 1,
					successCount: 1,
					failureCount: 0,
					skippedCount: 0,
					linksFound: 0,
					mediaFiles: 0,
					totalDataKb: 0,
				},
				eventSequence: 3,
			}),
		).toThrow();

		expect(storage.repos.pages.listForExport("crawl-item-rollback")).toEqual(
			[],
		);
		expect(
			storage.repos.crawlTerminals.listByCrawlId("crawl-item-rollback"),
		).toEqual([]);
		expect(
			storage.repos.crawlRuns.getById("crawl-item-rollback")?.eventSequence,
		).toBe(0);
	});
});

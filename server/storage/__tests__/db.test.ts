import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
			"0005_domain_state_search_content.sql",
		]);
		expect(rows.every((row) => typeof row.checksum === "string")).toBe(true);
	});

	test("0005 leaves legacy discovered link totals unknown instead of inferring from visible links", () => {
		const migrationDir = mkdtempSync(path.join(tmpdir(), "miku-migrations-"));
		const sourceDir = path.join(import.meta.dir, "../migrations");
		for (const fileName of [
			"0001_crawl_runs.sql",
			"0002_queue_pages.sql",
			"0003_pages_fts.sql",
			"0004_runtime_persistence.sql",
			"0005_domain_state_search_content.sql",
		]) {
			writeFileSync(
				path.join(migrationDir, fileName),
				readFileSync(path.join(sourceDir, fileName), "utf8"),
			);
		}
		writeFileSync(
			path.join(migrationDir, "0003z_seed_legacy_page.sql"),
			`
				INSERT INTO crawl_runs (id, target, status, options_json)
				VALUES ('legacy-crawl', 'https://legacy.example', 'completed', '{}');

				INSERT INTO pages (
					crawl_id,
					url,
					domain,
					is_dynamic,
					media_count,
					internal_links_count,
					external_links_count,
					main_content,
					content
				) VALUES (
					'legacy-crawl',
					'https://legacy.example/page',
					'legacy.example',
					0,
					0,
					1,
					2,
					'legacy body',
					NULL
				);
			`,
		);

		const db = new Database(":memory:");
		applyMigrations(db, migrationDir);

		const row = db
			.query(
				"SELECT discovered_links_count FROM pages WHERE crawl_id = 'legacy-crawl'",
			)
			.get() as { discovered_links_count: number };
		expect(row.discovered_links_count).toBe(0);
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

	test("crawl run persistence rejects invalid lifecycle state at the database boundary", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun(
			"crawl-constraints",
			"https://db.example",
			{
				target: "https://db.example",
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
			storage.db
				.query("UPDATE crawl_runs SET status = 'resumable-ish' WHERE id = ?")
				.run("crawl-constraints"),
		).toThrow();
		expect(() =>
			storage.db
				.query("UPDATE crawl_runs SET options_json = '{bad json' WHERE id = ?")
				.run("crawl-constraints"),
		).toThrow();
		expect(() =>
			storage.db
				.query(
					"UPDATE crawl_runs SET pages_scanned = 2, success_count = 1, failure_count = 0, skipped_count = 0 WHERE id = ?",
				)
				.run("crawl-constraints"),
		).toThrow();
		expect(() =>
			storage.db
				.query("UPDATE crawl_runs SET event_sequence = -1 WHERE id = ?")
				.run("crawl-constraints"),
		).toThrow();
	});

	test("runtime persistence tables reject impossible queue, page, and domain values", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun(
			"crawl-runtime-constraints",
			"https://db.example",
			{
				target: "https://db.example",
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
			storage.db
				.query(
					"INSERT INTO crawl_queue_items (crawl_id, url, depth, retries, domain, available_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(
					"crawl-runtime-constraints",
					"https://db.example/bad-depth",
					-1,
					0,
					"db.example",
					0,
				),
		).toThrow();
		expect(() =>
			storage.db
				.query(
					"INSERT INTO pages (crawl_id, url, domain, is_dynamic, media_count, internal_links_count, external_links_count, discovered_links_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					"crawl-runtime-constraints",
					"https://db.example/page",
					"db.example",
					2,
					0,
					0,
					0,
					0,
				),
		).toThrow();
		expect(() =>
			storage.repos.crawlDomainState.upsert("crawl-runtime-constraints", {
				delayKey: "https://db.example",
				delayMs: -1,
				nextAllowedAt: 0,
			}),
		).toThrow();
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

	test("domain delay state restores only for the requested crawlId", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun("crawl-domain-a", "https://a.example", {
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
		storage.repos.crawlRuns.createRun("crawl-domain-b", "https://b.example", {
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

		storage.repos.crawlDomainState.upsert("crawl-domain-a", {
			delayKey: "https://a.example",
			delayMs: 750,
			nextAllowedAt: 1234,
		});
		storage.repos.crawlDomainState.upsert("crawl-domain-b", {
			delayKey: "https://b.example",
			delayMs: 250,
			nextAllowedAt: 5678,
		});

		expect(
			storage.repos.crawlDomainState.listByCrawlId("crawl-domain-a"),
		).toEqual([
			{
				delayKey: "https://a.example",
				delayMs: 750,
				nextAllowedAt: 1234,
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

	test("page updates replace stale FTS terms for search", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun(
			"crawl-fts-update",
			"https://fts.example",
			{
				target: "https://fts.example",
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
		const pageInput = {
			crawlId: created.id,
			url: "https://fts.example/page",
			domain: "fts.example",
			contentType: "text/html",
			statusCode: 200,
			contentLength: 128,
			title: "Old needle",
			description: "Old description",
			content: "old needle body",
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
		};

		storage.repos.pages.save(pageInput);
		expect(storage.repos.search.count('"old"*')).toBe(1);
		expect(storage.repos.search.count('"fresh"*')).toBe(0);

		storage.repos.pages.save({
			...pageInput,
			title: "Fresh haystack",
			description: "Fresh description",
			content: "fresh haystack body",
		});

		expect(storage.repos.search.count('"old"*')).toBe(0);
		expect(storage.repos.search.count('"fresh"*')).toBe(1);
	});

	test("content-only pages remain searchable through extracted main content", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun(
			"crawl-content-only-search",
			"https://content-only.example",
			{
				target: "https://content-only.example",
				crawlMethod: "links",
				crawlDepth: 1,
				crawlDelay: 200,
				maxPages: 5,
				maxPagesPerDomain: 0,
				maxConcurrentRequests: 1,
				retryLimit: 0,
				dynamic: false,
				respectRobots: false,
				contentOnly: true,
				saveMedia: false,
			},
		);

		storage.repos.pages.save({
			crawlId: created.id,
			url: "https://content-only.example/page",
			domain: "content-only.example",
			contentType: "text/html",
			statusCode: 200,
			contentLength: 128,
			title: "Stored without source",
			description: "",
			content: null,
			isDynamic: false,
			lastModified: null,
			etag: null,
			processedContent: {
				extractedData: { mainContent: "uniquecontentonlyneedle body" },
				metadata: {},
				analysis: {},
				media: [],
				links: [],
				errors: [],
			},
			links: [],
		});

		expect(storage.repos.search.count('"uniquecontentonlyneedle"*')).toBe(1);
		const results = storage.repos.search.search(
			'"uniquecontentonlyneedle"*',
			10,
		);
		expect(results).toHaveLength(1);
		expect(results[0]?.snippet).toContain("uniquecontentonlyneedle");
		expect(storage.repos.pages.listForExport(created.id)[0]?.content).toBe(
			"uniquecontentonlyneedle body",
		);
	});

	test("empty raw content does not hide extracted main content from search", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun(
			"crawl-empty-content-search",
			"https://empty-content.example",
			{
				target: "https://empty-content.example",
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
			url: "https://empty-content.example/page",
			domain: "empty-content.example",
			contentType: "text/html",
			statusCode: 200,
			contentLength: 128,
			title: "Empty source",
			description: "",
			content: "",
			isDynamic: false,
			lastModified: null,
			etag: null,
			processedContent: {
				extractedData: { mainContent: "uniqueemptycontentneedle body" },
				metadata: {},
				analysis: {},
				media: [],
				links: [],
				errors: [],
			},
			links: [],
		});

		expect(storage.repos.search.count('"uniqueemptycontentneedle"*')).toBe(1);
	});

	test("search indexes canonical main content before raw HTML source", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun(
			"crawl-main-content-search",
			"https://main-content.example",
			{
				target: "https://main-content.example",
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
			url: "https://main-content.example/page",
			domain: "main-content.example",
			contentType: "text/html",
			statusCode: 200,
			contentLength: 128,
			title: "Canonical source",
			description: "",
			content: "<script>uniquerawonlyneedle()</script>",
			isDynamic: false,
			lastModified: null,
			etag: null,
			processedContent: {
				extractedData: { mainContent: "uniquemainonlyneedle body" },
				metadata: {},
				analysis: {},
				media: [],
				links: [],
				errors: [],
			},
			links: [],
		});

		expect(storage.repos.search.count('"uniquemainonlyneedle"*')).toBe(1);
		expect(storage.repos.search.count('"uniquerawonlyneedle"*')).toBe(0);
	});

	test("metadata-only search matches return non-empty snippets", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun(
			"crawl-metadata-search",
			"https://metadata.example",
			{
				target: "https://metadata.example",
				crawlMethod: "links",
				crawlDepth: 1,
				crawlDelay: 200,
				maxPages: 5,
				maxPagesPerDomain: 0,
				maxConcurrentRequests: 1,
				retryLimit: 0,
				dynamic: false,
				respectRobots: false,
				contentOnly: true,
				saveMedia: false,
			},
		);

		storage.repos.pages.save({
			crawlId: created.id,
			url: "https://metadata.example/title",
			domain: "metadata.example",
			contentType: "text/html",
			statusCode: 200,
			contentLength: 128,
			title: "uniquetitleonlyneedle",
			description: "",
			content: null,
			isDynamic: false,
			lastModified: null,
			etag: null,
			processedContent: {
				extractedData: { mainContent: "" },
				metadata: {},
				analysis: {},
				media: [],
				links: [],
				errors: [],
			},
			links: [],
		});
		storage.repos.pages.save({
			crawlId: created.id,
			url: "https://metadata.example/description",
			domain: "metadata.example",
			contentType: "text/html",
			statusCode: 200,
			contentLength: 128,
			title: "",
			description: "uniquedescriptiononlyneedle",
			content: null,
			isDynamic: false,
			lastModified: null,
			etag: null,
			processedContent: {
				extractedData: { mainContent: "" },
				metadata: {},
				analysis: {},
				media: [],
				links: [],
				errors: [],
			},
			links: [],
		});

		expect(
			storage.repos.search.search('"uniquetitleonlyneedle"*', 10)[0],
		).toEqual(
			expect.objectContaining({
				snippet: "uniquetitleonlyneedle",
			}),
		);
		expect(
			storage.repos.search.search('"uniquedescriptiononlyneedle"*', 10)[0],
		).toEqual(
			expect.objectContaining({
				snippet: "uniquedescriptiononlyneedle",
			}),
		);
	});

	test("search snippets prefer matched metadata before unrelated body text", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun(
			"crawl-metadata-snippet-priority",
			"https://metadata-snippet.example",
			{
				target: "https://metadata-snippet.example",
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
			url: "https://metadata-snippet.example/title",
			domain: "metadata-snippet.example",
			contentType: "text/html",
			statusCode: 200,
			contentLength: 128,
			title: "uniquetitlesnippetneedle",
			description: "",
			content: "<main>unrelated body text should not become the snippet</main>",
			isDynamic: false,
			lastModified: null,
			etag: null,
			processedContent: {
				extractedData: {
					mainContent: "unrelated body text should not become the snippet",
				},
				metadata: {},
				analysis: {},
				media: [],
				links: [],
				errors: [],
			},
			links: [],
		});

		const result = storage.repos.search.search(
			'"uniquetitlesnippetneedle"*',
			10,
		)[0];

		expect(result?.snippet).toContain("uniquetitlesnippetneedle");
		expect(result?.snippet).not.toContain("unrelated body text");
	});

	test("page link replay preserves nofollow metadata", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun(
			"crawl-link-metadata",
			"https://links.example",
			{
				target: "https://links.example",
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
			url: "https://links.example/page",
			domain: "links.example",
			contentType: "text/html",
			statusCode: 200,
			contentLength: 128,
			title: "Links",
			description: "",
			content: "<main>links</main>",
			isDynamic: false,
			lastModified: null,
			etag: null,
			processedContent: {
				extractedData: { mainContent: "links" },
				metadata: {},
				analysis: {},
				media: [],
				links: [],
				errors: [],
			},
			links: [
				{
					url: "https://links.example/follow",
					text: "Follow",
					nofollow: false,
				},
				{
					url: "https://links.example/nofollow",
					text: "No follow",
					nofollow: true,
				},
			],
		});

		expect(
			storage.repos.pages.getLinksByPageUrl(
				created.id,
				"https://links.example/page",
			),
		).toEqual([
			{
				url: "https://links.example/follow",
				text: "Follow",
				nofollow: false,
			},
			{
				url: "https://links.example/nofollow",
				text: "No follow",
				nofollow: true,
			},
		]);
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
			domainBudgetCharged: true,
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
			{
				url: "https://item.example/page",
				outcome: "success",
				domainBudgetCharged: true,
			},
		]);
		expect(storage.repos.crawlQueue.listPending("crawl-item")).toEqual([]);
		expect(storage.repos.crawlRuns.getById("crawl-item")?.eventSequence).toBe(
			7,
		);
	});

	test("terminal URL restore order follows insertion sequence inside one timestamp", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun(
			"crawl-terminal-order",
			"https://order.example",
			{
				target: "https://order.example",
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

		storage.repos.crawlTerminals.upsert(
			"crawl-terminal-order",
			"https://order.example/z-success",
			"success",
			true,
		);
		storage.repos.crawlTerminals.upsert(
			"crawl-terminal-order",
			"https://order.example/a-failure",
			"failure",
			false,
		);

		expect(
			storage.repos.crawlTerminals.listByCrawlId("crawl-terminal-order"),
		).toEqual([
			{
				url: "https://order.example/z-success",
				outcome: "success",
				domainBudgetCharged: true,
			},
			{
				url: "https://order.example/a-failure",
				outcome: "failure",
				domainBudgetCharged: false,
			},
		]);
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
				domainBudgetCharged: true,
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

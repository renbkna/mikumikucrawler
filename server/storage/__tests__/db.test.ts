import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
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
			"0006_canonical_schema.sql",
		]);
		expect(rows.every((row) => typeof row.checksum === "string")).toBe(true);
		expect(storage.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
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
			.query("SELECT discovered_links_count FROM pages WHERE crawl_id = 'legacy-crawl'")
			.get() as { discovered_links_count: number };
		expect(row.discovered_links_count).toBe(0);
	});

	test("fails startup when an applied migration file changes", () => {
		const migrationDir = mkdtempSync(path.join(tmpdir(), "miku-migrations-"));
		const migrationPath = path.join(migrationDir, "0001_test.sql");
		writeFileSync(migrationPath, "CREATE TABLE test_table (id TEXT PRIMARY KEY);");

		const db = new Database(":memory:");
		applyMigrations(db, migrationDir);

		writeFileSync(migrationPath, "CREATE TABLE test_table (id TEXT PRIMARY KEY, changed TEXT);");

		expect(() => applyMigrations(db, migrationDir)).toThrow("checksum mismatch");
	});

	test("fails startup when the database ledger names an absent migration", () => {
		const migrationDir = mkdtempSync(path.join(tmpdir(), "miku-migrations-"));
		writeFileSync(
			path.join(migrationDir, "0001_test.sql"),
			"CREATE TABLE test_table (id TEXT PRIMARY KEY);",
		);
		const db = new Database(":memory:");
		applyMigrations(db, migrationDir);
		db.query("INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)").run(
			"9999_missing.sql",
			"missing",
		);

		expect(() => applyMigrations(db, migrationDir)).toThrow(
			"is not present in this release lineage",
		);
	});

	test("upgrades legacy migration ledgers without a checksum column", () => {
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

		applyMigrations(db, migrationDir);
		expect(
			(
				db.query("SELECT checksum FROM schema_migrations WHERE id = '0001_test.sql'").get() as {
					checksum: string;
				}
			).checksum,
		).toBe("legacy-unverified");
	});

	test("upgrades known applied migration rows with null checksums", () => {
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

		applyMigrations(db, migrationDir);
		expect(
			(
				db.query("SELECT checksum FROM schema_migrations WHERE id = '0001_test.sql'").get() as {
					checksum: string;
				}
			).checksum,
		).toBe("legacy-unverified");
	});

	test("accepts a known historical checksum and canonicalizes its schema", () => {
		const db = new Database(":memory:");
		db.exec(`
			CREATE TABLE schema_migrations (
				id TEXT PRIMARY KEY,
				applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				checksum TEXT NOT NULL
			);
			INSERT INTO schema_migrations (id, checksum)
			VALUES (
				'0001_crawl_runs.sql',
				'8f3a188974f103571720f1976bec802baa5b218b6b4c71549914458d5b57ce65'
			);
			CREATE TABLE crawl_runs (
				id TEXT PRIMARY KEY,
				target TEXT NOT NULL,
				status TEXT NOT NULL,
				stop_reason TEXT,
				options_json TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				started_at TEXT,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				completed_at TEXT,
				pages_scanned INTEGER NOT NULL DEFAULT 0,
				success_count INTEGER NOT NULL DEFAULT 0,
				failure_count INTEGER NOT NULL DEFAULT 0,
				skipped_count INTEGER NOT NULL DEFAULT 0,
				links_found INTEGER NOT NULL DEFAULT 0,
				media_files INTEGER NOT NULL DEFAULT 0,
				total_data_kb INTEGER NOT NULL DEFAULT 0,
				event_sequence INTEGER NOT NULL DEFAULT 0
			);
			INSERT INTO crawl_runs (id, target, status, options_json)
			VALUES (
				'historical-run',
				'https://wrong.example',
				'paused',
				'{"target":"https://historical.example","crawlMethod":"links","crawlDepth":2,"crawlDelay":1000,"maxPagesPerDomain":0,"maxConcurrentRequests":5,"retryLimit":3,"dynamic":true,"respectRobots":true,"contentOnly":false,"saveMedia":true}'
			);
		`);

		applyMigrations(db);

		expect(() =>
			db
				.query(`
				INSERT INTO crawl_runs (id, target, status, options_json)
				VALUES ('invalid', 'https://example.com', 'invented', '{}')
			`)
				.run(),
		).toThrow();
		expect(
			(db.query("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number })
				.count,
		).toBe(6);
		const migrated = db
			.query("SELECT target, options_json FROM crawl_runs WHERE id = 'historical-run'")
			.get() as { target: string; options_json: string };
		expect(migrated.target).toBe("https://historical.example/");
		expect(JSON.parse(migrated.options_json)).toMatchObject({
			target: "https://historical.example/",
			maxPages: 50,
			saveMedia: false,
		});
	});

	test("migrates the pre-chain schema without discarding pages, links, or resumable sessions", () => {
		const db = new Database(":memory:");
		db.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE pages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				url TEXT UNIQUE,
				domain TEXT,
				crawled_at TEXT DEFAULT CURRENT_TIMESTAMP,
				last_modified TEXT,
				etag TEXT,
				content_type TEXT,
				status_code INTEGER,
				data_length INTEGER,
				title TEXT,
				description TEXT,
				content TEXT,
				is_dynamic INTEGER DEFAULT 0,
				main_content TEXT,
				word_count INTEGER,
				reading_time INTEGER,
				language TEXT,
				keywords TEXT,
				quality_score INTEGER,
				structured_data TEXT,
				media_count INTEGER,
				internal_links_count INTEGER,
				external_links_count INTEGER
			);
			CREATE TABLE links (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source_id INTEGER,
				target_url TEXT,
				text TEXT,
				FOREIGN KEY (source_id) REFERENCES pages(id) ON DELETE CASCADE,
				UNIQUE(source_id, target_url)
			);
			CREATE TABLE domain_settings (
				domain TEXT PRIMARY KEY,
				robots_txt TEXT,
				crawl_delay INTEGER DEFAULT 1000,
				last_crawled TEXT,
				allowed INTEGER DEFAULT 1
			);
			CREATE TABLE crawl_sessions (
				id TEXT PRIMARY KEY,
				socket_id TEXT,
				target TEXT,
				options TEXT,
				status TEXT DEFAULT 'running',
				stats TEXT,
				created_at TEXT DEFAULT CURRENT_TIMESTAMP,
				updated_at TEXT DEFAULT CURRENT_TIMESTAMP
			);
			CREATE TABLE queue_items (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT,
				url TEXT,
				depth INTEGER DEFAULT 0,
				retries INTEGER DEFAULT 0,
				parent_url TEXT,
				domain TEXT,
				FOREIGN KEY (session_id) REFERENCES crawl_sessions(id) ON DELETE CASCADE,
				UNIQUE(session_id, url)
			);

			INSERT INTO pages (
				url, domain, content_type, status_code, data_length, title, content,
				main_content, media_count, internal_links_count, external_links_count
			) VALUES (
				'https://legacy.example/page', 'legacy.example', 'text/html', 200, 2048,
				'Legacy page', '<html>legacy</html>', 'legacy body', 2, 1, 0
			);
			INSERT INTO links (source_id, target_url, text)
			VALUES (1, 'https://legacy.example/next', 'next');
			INSERT INTO domain_settings (domain, robots_txt, crawl_delay)
			VALUES ('legacy.example', 'User-agent: *', 1500);
			INSERT INTO crawl_sessions (id, socket_id, target, options, status)
			VALUES (
				'legacy-session',
				'old-socket',
				'https://resume.example',
				'{"target":"https://resume.example","crawlMethod":"links","crawlDepth":2,"crawlDelay":1000,"maxPages":50,"maxPagesPerDomain":0,"maxConcurrentRequests":5,"retryLimit":3,"dynamic":true,"respectRobots":true,"contentOnly":false,"saveMedia":true}',
				'interrupted'
			);
			INSERT INTO queue_items (session_id, url, depth, retries, domain)
			VALUES ('legacy-session', 'https://resume.example/pending', 1, 0, 'resume.example');
		`);

		applyMigrations(db);

		const archivedRun = db
			.query(
				"SELECT id, pages_scanned, success_count FROM crawl_runs WHERE id LIKE 'legacy-v0-unscoped-pages%'",
			)
			.get() as { id: string; pages_scanned: number; success_count: number };
		expect(archivedRun.pages_scanned).toBe(1);
		expect(archivedRun.success_count).toBe(1);
		expect(
			(
				db.query("SELECT COUNT(*) AS count FROM pages WHERE crawl_id = ?").get(archivedRun.id) as {
					count: number;
				}
			).count,
		).toBe(1);
		expect(
			(db.query("SELECT COUNT(*) AS count FROM page_links").get() as { count: number }).count,
		).toBe(1);

		const session = db
			.query("SELECT status, options_json FROM crawl_runs WHERE id = 'legacy-session'")
			.get() as { status: string; options_json: string };
		expect(session.status).toBe("interrupted");
		expect(JSON.parse(session.options_json).saveMedia).toBe(false);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM crawl_queue_items WHERE crawl_id = 'legacy-session'",
					)
					.get() as {
					count: number;
				}
			).count,
		).toBe(1);
		expect(
			(
				db.query("SELECT COUNT(*) AS count FROM legacy_v0_domain_settings").get() as {
					count: number;
				}
			).count,
		).toBe(1);
	});

	test("rolls legacy migration back completely when the release lineage is unknown", () => {
		const db = new Database(":memory:");
		db.exec(`
			CREATE TABLE pages (id INTEGER PRIMARY KEY, url TEXT);
			INSERT INTO pages (id, url) VALUES (1, 'https://legacy.example');
			CREATE TABLE schema_migrations (
				id TEXT PRIMARY KEY,
				applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				checksum TEXT NOT NULL
			);
			INSERT INTO schema_migrations (id, checksum) VALUES ('9999_unknown.sql', 'unknown');
		`);

		expect(() => applyMigrations(db)).toThrow("is not present in this release lineage");
		expect((db.query("SELECT COUNT(*) AS count FROM pages").get() as { count: number }).count).toBe(
			1,
		);
		expect(
			db
				.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'legacy_v0_pages'")
				.get(),
		).toBeNull();
	});

	test("crawl run persistence rejects invalid lifecycle state at the database boundary", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun("crawl-constraints", {
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
		});

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
				.query("UPDATE crawl_runs SET pages_scanned = 1.5, success_count = 1.5 WHERE id = ?")
				.run("crawl-constraints"),
		).toThrow();
		expect(() =>
			storage.db
				.query("UPDATE crawl_runs SET target = 'https://other.example/' WHERE id = ?")
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
		storage.repos.crawlRuns.createRun("crawl-runtime-constraints", {
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
		});

		expect(() =>
			storage.db
				.query(
					"INSERT INTO crawl_queue_items (crawl_id, url, depth, retries, domain, available_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run("crawl-runtime-constraints", "https://db.example/bad-depth", -1, 0, "db.example", 0),
		).toThrow();
		expect(() =>
			storage.db
				.query(
					"INSERT INTO pages (crawl_id, url, domain, is_dynamic, media_count, internal_links_count, external_links_count, discovered_links_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run("crawl-runtime-constraints", "https://db.example/page", "db.example", 2, 0, 0, 0, 0),
		).toThrow();
		expect(() =>
			storage.repos.crawlDomainState.upsert("crawl-runtime-constraints", {
				delayKey: "https://db.example",
				delayMs: -1,
				nextAllowedAt: 0,
			}),
		).toThrow();
		expect(() =>
			storage.db
				.query(
					"INSERT INTO crawl_domain_state (crawl_id, delay_key, delay_ms, next_allowed_at) VALUES (?, ?, ?, ?)",
				)
				.run("crawl-runtime-constraints", "https://db.example", 60_001, Date.now()),
		).toThrow();
	});

	test("queue items restore only for the requested crawlId", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun("crawl-a", {
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
		storage.repos.crawlRuns.createRun("crawl-b", {
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
				url: "https://a.example/",
				domain: "a.example",
				depth: 0,
				retries: 0,
				availableAt: 0,
			},
			{
				url: "https://a.example/one",
				domain: "a.example",
				depth: 1,
				retries: 0,
				availableAt: 0,
			},
		]);
	});

	test("domain delay state restores only for the requested crawlId", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun("crawl-domain-a", {
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
		storage.repos.crawlRuns.createRun("crawl-domain-b", {
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

		expect(storage.repos.crawlDomainState.listByCrawlId("crawl-domain-a")).toEqual([
			{
				delayKey: "https://a.example",
				delayMs: 750,
				nextAllowedAt: 1234,
			},
		]);
	});

	test("typed counters are read from columns without JSON reparsing", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun("crawl-typed", {
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
		});

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
		const created = storage.repos.crawlRuns.createRun("crawl-filter", {
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
		});

		expect(
			storage.repos.crawlRuns.list({ from: created.createdAt }).map((run) => run.id),
		).toContain("crawl-filter");
	});

	test("export rows expose camelCase fields expected by the API layer", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun("crawl-export", {
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
		});

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

		const rows = Array.from(storage.repos.pages.iterateForExport(created.id));
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
		const created = storage.repos.crawlRuns.createRun("crawl-fts-update", {
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
		});
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
		expect(storage.repos.search.count(created.id, '"old"*')).toBe(1);
		expect(storage.repos.search.count(created.id, '"fresh"*')).toBe(0);

		storage.repos.pages.save({
			...pageInput,
			title: "Fresh haystack",
			description: "Fresh description",
			content: "fresh haystack body",
		});

		expect(storage.repos.search.count(created.id, '"old"*')).toBe(0);
		expect(storage.repos.search.count(created.id, '"fresh"*')).toBe(1);

		const other = storage.repos.crawlRuns.createRun("crawl-fts-other", {
			...created.options,
			target: "https://other.example",
		});
		storage.repos.pages.save({
			...pageInput,
			crawlId: other.id,
			url: "https://other.example/page",
			domain: "other.example",
		});
		expect(storage.repos.search.count(other.id, '"old"*')).toBe(1);
		expect(storage.repos.search.search(created.id, '"old"*', 10)).toEqual([]);
	});

	test("content-only pages remain searchable through extracted main content", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun("crawl-content-only-search", {
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
		});

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

		expect(storage.repos.search.count(created.id, '"uniquecontentonlyneedle"*')).toBe(1);
		const results = storage.repos.search.search(created.id, '"uniquecontentonlyneedle"*', 10);
		expect(results).toHaveLength(1);
		expect(results[0]?.snippet).toContain("uniquecontentonlyneedle");
		expect(Array.from(storage.repos.pages.iterateForExport(created.id))[0]?.content).toBe(
			"uniquecontentonlyneedle body",
		);
	});

	test("empty raw content does not hide extracted main content from search", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun("crawl-empty-content-search", {
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
		});

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

		expect(storage.repos.search.count(created.id, '"uniqueemptycontentneedle"*')).toBe(1);
	});

	test("search indexes canonical main content before raw HTML source", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun("crawl-main-content-search", {
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
		});

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

		expect(storage.repos.search.count(created.id, '"uniquemainonlyneedle"*')).toBe(1);
		expect(storage.repos.search.count(created.id, '"uniquerawonlyneedle"*')).toBe(0);
	});

	test("metadata-only search matches return non-empty snippets", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun("crawl-metadata-search", {
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
		});

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

		expect(storage.repos.search.search(created.id, '"uniquetitleonlyneedle"*', 10)[0]).toEqual(
			expect.objectContaining({
				snippet: "uniquetitleonlyneedle",
			}),
		);
		expect(
			storage.repos.search.search(created.id, '"uniquedescriptiononlyneedle"*', 10)[0],
		).toEqual(
			expect.objectContaining({
				snippet: "uniquedescriptiononlyneedle",
			}),
		);
	});

	test("search snippets prefer matched metadata before unrelated body text", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun("crawl-metadata-snippet-priority", {
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
		});

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

		const result = storage.repos.search.search(created.id, '"uniquetitlesnippetneedle"*', 10)[0];

		expect(result?.snippet).toContain("uniquetitlesnippetneedle");
		expect(result?.snippet).not.toContain("unrelated body text");
	});

	test("page link replay preserves nofollow metadata", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun("crawl-link-metadata", {
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
		});

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

		expect(storage.repos.pages.getLinksByPageUrl(created.id, "https://links.example/page")).toEqual(
			[
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
		);
	});

	test("item completion commits page, terminal, queue removal, counters, and event sequence atomically", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun("crawl-item", {
			target: "https://item.example/page",
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
		const result = storage.repos.crawlItems.commitCompletedItem({
			crawlId: "crawl-item",
			url: "https://item.example/page",
			outcome: "success",
			domainBudgetCharged: true,
			page: {
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
		expect(Array.from(storage.repos.pages.iterateForExport("crawl-item"))).toHaveLength(1);
		expect(storage.repos.crawlItems.listTerminalUrls("crawl-item")).toEqual([
			{
				url: "https://item.example/page",
				outcome: "success",
				domainBudgetCharged: true,
			},
		]);
		expect(storage.repos.crawlQueue.listPending("crawl-item")).toEqual([]);
		expect(storage.repos.crawlRuns.getById("crawl-item")?.eventSequence).toBe(7);

		storage.repos.crawlItems.commitCompletedItem({
			crawlId: "crawl-item",
			url: "https://item.example/page",
			outcome: "failure",
			domainBudgetCharged: false,
			counters: {
				pagesScanned: 1,
				successCount: 1,
				failureCount: 0,
				skippedCount: 0,
				linksFound: 0,
				mediaFiles: 0,
				totalDataKb: 2,
			},
			eventSequence: 8,
		});
		expect(storage.repos.crawlItems.listTerminalUrls("crawl-item")).toEqual([
			{
				url: "https://item.example/page",
				outcome: "success",
				domainBudgetCharged: true,
			},
		]);
	});

	test("terminal URL restore order follows insertion sequence inside one timestamp", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun("crawl-terminal-order", {
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
		});

		const counters = {
			pagesScanned: 0,
			successCount: 0,
			failureCount: 0,
			skippedCount: 0,
			linksFound: 0,
			mediaFiles: 0,
			totalDataKb: 0,
		};
		storage.repos.crawlItems.commitCompletedItem({
			crawlId: "crawl-terminal-order",
			url: "https://order.example/z-success",
			outcome: "success",
			domainBudgetCharged: true,
			counters,
			eventSequence: 1,
		});
		storage.repos.crawlItems.commitCompletedItem({
			crawlId: "crawl-terminal-order",
			url: "https://order.example/a-failure",
			outcome: "failure",
			domainBudgetCharged: false,
			counters,
			eventSequence: 2,
		});

		expect(storage.repos.crawlItems.listTerminalUrls("crawl-terminal-order")).toEqual([
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
		storage.repos.crawlRuns.createRun("crawl-item-rollback", {
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
		});

		expect(() =>
			storage.repos.crawlItems.commitCompletedItem({
				crawlId: "crawl-item-rollback",
				url: "https://rollback.example/page",
				outcome: "invalid" as never,
				domainBudgetCharged: true,
				page: {
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

		expect(Array.from(storage.repos.pages.iterateForExport("crawl-item-rollback"))).toEqual([]);
		expect(storage.repos.crawlItems.listTerminalUrls("crawl-item-rollback")).toEqual([]);
		expect(storage.repos.crawlRuns.getById("crawl-item-rollback")?.eventSequence).toBe(0);
	});
});

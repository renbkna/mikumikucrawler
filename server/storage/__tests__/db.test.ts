import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { persistPageFixture } from "../../__tests__/pageFixture.js";
import {
	createCrawlOptionsFixture,
	createInMemoryStorage,
} from "../../__tests__/storageFixture.js";
import { DurableStorageBudget } from "../DurableStorageBudget.js";
import { createStorage, DatabaseOwnershipError } from "../db.js";

describe("storage contract", () => {
	test("creates the current schema without a migration ledger", () => {
		const storage = createInMemoryStorage();
		expect(
			storage.db
				.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
				.get(),
		).toBeNull();
		expect(storage.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
		const runColumns = (
			storage.db.query("PRAGMA table_info(crawl_runs)").all() as Array<{ name: string }>
		).map((column) => column.name);
		const pageColumns = (
			storage.db.query("PRAGMA table_info(pages)").all() as Array<{ name: string }>
		).map((column) => column.name);
		expect(runColumns).not.toContain("target");
		expect(runColumns).not.toContain("total_data_kb");
		for (const deadColumn of [
			"last_modified",
			"etag",
			"status_code",
			"data_length",
			"is_dynamic",
			"keywords",
			"quality_score",
			"structured_data",
			"media_count",
			"internal_links_count",
			"external_links_count",
			"discovered_links_count",
		]) {
			expect(pageColumns).not.toContain(deadColumn);
		}
		expect(
			storage.db
				.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'page_links'")
				.get(),
		).toBeNull();
		expect(
			storage.db
				.query(
					"SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_crawl_domain_state_crawl_id'",
				)
				.get(),
		).toBeNull();
		const domainStatePlan = storage.db
			.query(
				"EXPLAIN QUERY PLAN SELECT delay_key, delay_ms, next_allowed_at FROM crawl_domain_state WHERE crawl_id = ? ORDER BY delay_key",
			)
			.all("crawl-id") as Array<{ detail: string }>;
		expect(domainStatePlan.some(({ detail }) => detail.includes("(crawl_id=?)"))).toBe(true);
		expect((storage.db.query("PRAGMA temp_store").get() as { temp_store: number }).temp_store).toBe(
			1,
		);
	});

	test("one live process owns the database while matching-schema data survives restart", () => {
		const databasePath = path.join(
			mkdtempSync(path.join(tmpdir(), "miku-owned-db-")),
			"crawler.db",
		);
		const owner = createStorage(databasePath);
		owner.repos.crawlRuns.createRun("preserved-run", createCrawlOptionsFixture());

		expect(() => createStorage(databasePath)).toThrow(DatabaseOwnershipError);
		owner.close();
		const nextOwner = createStorage(databasePath);
		expect(() => owner.repos.crawlRuns.list()).toThrow();
		expect(nextOwner.repos.crawlRuns.getById("preserved-run")).not.toBeNull();
		nextOwner.close();
	});

	test("replaces an incompatible database with the current schema", () => {
		const databasePath = path.join(
			mkdtempSync(path.join(tmpdir(), "miku-incompatible-db-")),
			"crawler.db",
		);
		const incompatible = new Database(databasePath);
		incompatible.exec(
			"CREATE TABLE legacy_data (value TEXT); INSERT INTO legacy_data VALUES ('old');",
		);
		incompatible.close();

		const storage = createStorage(databasePath);
		expect(
			storage.db
				.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'legacy_data'")
				.get(),
		).toBeNull();
		expect(
			storage.db
				.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'crawl_runs'")
				.get(),
		).not.toBeNull();
		storage.close();
	});

	test("durable capacity reclaims the oldest terminal run and protects resumable state", () => {
		const storage = createInMemoryStorage();
		const options = createCrawlOptionsFixture({
			target: "https://placeholder.example/",
			maxPages: 1,
		});
		for (const [crawlId, target] of [
			["a-old-terminal", "https://old.example/"],
			["z-new-terminal", "https://new.example/"],
		] as const) {
			storage.repos.crawlRuns.createRun(crawlId, { ...options, target });
			persistPageFixture(storage, {
				crawlId,
				url: target,
				contentLength: 128 * 1024,
				title: crawlId,
				content: `<main>${"x".repeat(128 * 1024)}</main>`,
				mainContent: "x".repeat(128 * 1024),
			});
			storage.repos.crawlRuns.markCompleted(crawlId, null);
		}
		storage.db
			.query("UPDATE crawl_runs SET completed_at = '2026-01-01 00:00:00' WHERE id = ?")
			.run("a-old-terminal");
		storage.db
			.query("UPDATE crawl_runs SET completed_at = '2026-02-01 00:00:00' WHERE id = ?")
			.run("z-new-terminal");
		storage.repos.crawlRuns.createRun("paused-checkpoint", {
			...options,
			target: "https://paused.example/",
		});
		storage.repos.crawlRuns.markPaused("paused-checkpoint", "Pause requested");

		const pageSize = (storage.db.query("PRAGMA page_size").get() as { page_size: number })
			.page_size;
		const usedBefore = storage.budget.usedBytes();
		const constrainedBudget = new DurableStorageBudget(storage.db, {
			maxBytes: usedBefore + pageSize - 1,
			pageReservationBytes: pageSize,
		});
		const reservation = constrainedBudget.reserve("next-crawl", {
			maxPages: 1,
			pagesScanned: 0,
		});

		expect(reservation).toEqual({
			reservedBytes: pageSize,
			reclaimedCrawlIds: ["a-old-terminal"],
		});
		expect(storage.repos.crawlRuns.getById("a-old-terminal")).toBeNull();
		expect(storage.repos.crawlRuns.getById("z-new-terminal")?.status).toBe("completed");
		expect(storage.repos.crawlRuns.getById("paused-checkpoint")?.status).toBe("paused");
	});

	test("reclamation rolls back failed admission and excludes settling runtime owners", () => {
		const storage = createInMemoryStorage();
		const options = createCrawlOptionsFixture({ maxPages: 1 });
		for (const [crawlId, target] of [
			["owned-terminal", "https://owned.example/"],
			["reclaimable-terminal", "https://reclaimable.example/"],
		] as const) {
			storage.repos.crawlRuns.createRun(crawlId, { ...options, target });
			persistPageFixture(storage, {
				crawlId,
				url: target,
				contentLength: 128 * 1024,
				content: `<main>${"x".repeat(128 * 1024)}</main>`,
				mainContent: "x".repeat(128 * 1024),
			});
			storage.repos.crawlRuns.markCompleted(crawlId, null);
		}
		storage.db
			.query("UPDATE crawl_runs SET completed_at = '2026-01-01 00:00:00' WHERE id = ?")
			.run("owned-terminal");
		storage.db
			.query("UPDATE crawl_runs SET completed_at = '2026-02-01 00:00:00' WHERE id = ?")
			.run("reclaimable-terminal");

		const pageSize = (storage.db.query("PRAGMA page_size").get() as { page_size: number })
			.page_size;
		const budget = new DurableStorageBudget(storage.db, {
			maxBytes: storage.budget.usedBytes() + pageSize - 1,
			pageReservationBytes: pageSize,
		});
		budget.reserve("owned-terminal", { maxPages: 1, pagesScanned: 1 });

		expect(() =>
			budget.reserve("failed-admission", { maxPages: 1, pagesScanned: 0 }, () => {
				throw new Error("admission failed");
			}),
		).toThrow("admission failed");
		expect(storage.repos.crawlRuns.getById("owned-terminal")).not.toBeNull();
		expect(storage.repos.crawlRuns.getById("reclaimable-terminal")).not.toBeNull();

		const reservation = budget.reserve("accepted-admission", {
			maxPages: 1,
			pagesScanned: 0,
		});
		expect(reservation.reclaimedCrawlIds).toEqual(["reclaimable-terminal"]);
		expect(storage.repos.crawlRuns.getById("owned-terminal")).not.toBeNull();
		expect(storage.repos.crawlRuns.getById("reclaimable-terminal")).toBeNull();
	});

	test("page observations expose neither an independent writer nor same-run cache authority", () => {
		const storage = createInMemoryStorage();

		expect(storage.repos.pages).not.toHaveProperty("save");
		expect(storage.repos.pages).not.toHaveProperty("getHeaders");
		expect(storage.repos.pages).not.toHaveProperty("getLinksByPageUrl");
		expect(storage.repos.pages).not.toHaveProperty("getDiscoveredLinkCountByPageUrl");
	});

	test("default crawl history ordering uses its global updated-at index", () => {
		const storage = createInMemoryStorage();
		const plan = storage.db
			.query("EXPLAIN QUERY PLAN SELECT * FROM crawl_runs ORDER BY updated_at DESC LIMIT 50")
			.all() as Array<{ detail: string }>;

		expect(plan.some((row) => row.detail.includes("idx_crawl_runs_updated_at"))).toBe(true);
	});

	test("crawl run persistence rejects invalid lifecycle state at the database boundary", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun(
			"crawl-constraints",
			createCrawlOptionsFixture({ target: "https://db.example" }),
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
				.query("UPDATE crawl_runs SET pages_scanned = 1.5, success_count = 1.5 WHERE id = ?")
				.run("crawl-constraints"),
		).toThrow();
		expect(() =>
			storage.db
				.query("UPDATE crawl_runs SET event_sequence = -1 WHERE id = ?")
				.run("crawl-constraints"),
		).toThrow();
		storage.db
			.query("UPDATE crawl_runs SET created_at = '2026-02-30 00:00:00' WHERE id = ?")
			.run("crawl-constraints");
		expect(() => storage.repos.crawlRuns.getById("crawl-constraints")).toThrow(
			"Persisted timestamp is outside the date-time contract",
		);
	});

	test("preserves fractional list bounds against second-precision storage", () => {
		const storage = createInMemoryStorage();
		const run = storage.repos.crawlRuns.createRun(
			"fractional-list-bound",
			createCrawlOptionsFixture(),
		);
		storage.db
			.query("UPDATE crawl_runs SET updated_at = '2026-01-01 00:00:00' WHERE id = ?")
			.run(run.id);

		expect(storage.repos.crawlRuns.list({ from: "2026-01-01T00:00:00.001Z" })).toEqual([]);
		expect(storage.repos.crawlRuns.list({ to: "2026-01-01T00:00:00.999Z" })).toEqual([
			expect.objectContaining({ id: run.id }),
		]);
	});

	test("runtime persistence tables reject impossible queue, page, and domain values", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun(
			"crawl-runtime-constraints",
			createCrawlOptionsFixture({ target: "https://db.example" }),
		);

		expect(() =>
			storage.db
				.query(
					"INSERT INTO crawl_queue_items (crawl_id, url, depth, retries, domain, available_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run("crawl-runtime-constraints", "https://db.example/bad-depth", -1, 0, "db.example", 0),
		).toThrow();
		expect(() =>
			storage.db
				.query("INSERT INTO pages (crawl_id, url, domain, word_count) VALUES (?, ?, ?, ?)")
				.run("crawl-runtime-constraints", "https://db.example/page", "db.example", -1),
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
		storage.repos.crawlRuns.createRun(
			"crawl-a",
			createCrawlOptionsFixture({ target: "https://a.example" }),
		);
		storage.repos.crawlRuns.createRun(
			"crawl-b",
			createCrawlOptionsFixture({ target: "https://b.example" }),
		);

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

	test("queue writes reject duplicate admission and cannot recreate missing pending work", () => {
		const storage = createInMemoryStorage();
		const crawl = storage.repos.crawlRuns.createRun(
			"queue-single-assignment",
			createCrawlOptionsFixture({ target: "https://queue-single.example" }),
		);
		const initial = storage.repos.crawlQueue.listPending(crawl.id)[0];
		if (!initial) throw new Error("Expected the initial queue item");

		expect(() => storage.repos.crawlQueue.enqueueMany(crawl.id, [initial])).toThrow();
		storage.db
			.query("DELETE FROM crawl_queue_items WHERE crawl_id = ? AND url = ?")
			.run(crawl.id, initial.url);
		expect(() => storage.repos.crawlQueue.reschedule(crawl.id, { ...initial, retries: 1 })).toThrow(
			`Cannot reschedule non-pending crawl URL: ${initial.url}`,
		);
		expect(storage.repos.crawlQueue.listPending(crawl.id)).toEqual([]);
	});

	test("domain delay state restores only for the requested crawlId", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun(
			"crawl-domain-a",
			createCrawlOptionsFixture({ target: "https://a.example" }),
		);
		storage.repos.crawlRuns.createRun(
			"crawl-domain-b",
			createCrawlOptionsFixture({ target: "https://b.example" }),
		);

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

	test("item completion owns exact typed aggregates and terminal cleanup owns resume replicas", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun(
			"crawl-typed",
			createCrawlOptionsFixture({ target: "https://typed.example" }),
		);
		storage.repos.crawlDomainState.upsert("crawl-typed", {
			delayKey: "https://typed.example",
			delayMs: 250,
			nextAllowedAt: 1_000,
		});
		const committed = storage.repos.crawlItems.commitCompletedItem({
			crawlId: "crawl-typed",
			url: "https://typed.example/",
			outcome: "success",
			domainBudgetCharged: true,
			page: {
				contentType: "text/html",
				contentLength: 1_536,
				title: "Typed aggregate",
				description: "",
				content: "<main>Typed aggregate</main>",
				mainContent: "Typed aggregate",
				wordCount: 0,
				readingTime: 0,
				language: "unknown",
				mediaCount: 0,
				discoveredLinkCount: 0,
			},
			eventSequence: 4,
		});

		expect(committed.counters.totalDataKb).toBe(1.5);
		storage.repos.crawlRuns.markCompleted("crawl-typed", null, 5);

		const loaded = storage.repos.crawlRuns.getById("crawl-typed");
		expect(loaded?.counters).toEqual({
			pagesScanned: 1,
			successCount: 1,
			failureCount: 0,
			skippedCount: 0,
			linksFound: 0,
			mediaFiles: 0,
			totalDataKb: 1.5,
		});
		expect(storage.repos.crawlQueue.listPending("crawl-typed")).toEqual([]);
		expect(storage.repos.crawlItems.listTerminalUrls("crawl-typed")).toEqual([]);
		expect(storage.repos.crawlDomainState.listByCrawlId("crawl-typed")).toEqual([]);
	});

	test("date filters accept API ISO timestamps without dropping matching rows", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun(
			"crawl-filter",
			createCrawlOptionsFixture({ target: "https://filter.example" }),
		);

		expect(
			storage.repos.crawlRuns.list({ from: created.createdAt }).map((run) => run.id),
		).toContain("crawl-filter");
	});

	test("export rows expose camelCase fields expected by the API layer", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun(
			"crawl-export",
			createCrawlOptionsFixture({ target: "https://export.example" }),
		);

		persistPageFixture(storage, {
			crawlId: created.id,
			url: "https://export.example/page",
			title: "Exported page",
			description: "Export description",
			content: "Export body",
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
		const created = storage.repos.crawlRuns.createRun(
			"crawl-fts-update",
			createCrawlOptionsFixture({ target: "https://fts.example" }),
		);
		const pageInput = {
			crawlId: created.id,
			url: "https://fts.example/page",
			title: "Old needle",
			description: "Old description",
			content: "old needle body",
		};

		persistPageFixture(storage, pageInput);
		expect(storage.repos.search.count(created.id, '"old"*')).toBe(1);
		expect(storage.repos.search.count(created.id, '"fresh"*')).toBe(0);

		storage.db
			.query(
				"UPDATE pages SET title = ?, description = ?, content = ? WHERE crawl_id = ? AND url = ?",
			)
			.run("Fresh haystack", "Fresh description", "fresh haystack body", created.id, pageInput.url);

		expect(storage.repos.search.count(created.id, '"old"*')).toBe(0);
		expect(storage.repos.search.count(created.id, '"fresh"*')).toBe(1);

		const other = storage.repos.crawlRuns.createRun("crawl-fts-other", {
			...created.options,
			target: "https://other.example",
		});
		persistPageFixture(storage, {
			...pageInput,
			crawlId: other.id,
			url: "https://other.example/page",
		});
		expect(storage.repos.search.count(other.id, '"old"*')).toBe(1);
		expect(storage.repos.search.search(created.id, '"old"*', 10)).toEqual([]);
	});

	test("content-only pages remain searchable through extracted main content", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun(
			"crawl-content-only-search",
			createCrawlOptionsFixture({ target: "https://content-only.example", contentOnly: true }),
		);

		persistPageFixture(storage, {
			crawlId: created.id,
			url: "https://content-only.example/page",
			title: "Stored without source",
			content: null,
			mainContent: "uniquecontentonlyneedle body",
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
		const created = storage.repos.crawlRuns.createRun(
			"crawl-empty-content-search",
			createCrawlOptionsFixture({ target: "https://empty-content.example" }),
		);

		persistPageFixture(storage, {
			crawlId: created.id,
			url: "https://empty-content.example/page",
			title: "Empty source",
			content: "",
			mainContent: "uniqueemptycontentneedle body",
		});

		expect(storage.repos.search.count(created.id, '"uniqueemptycontentneedle"*')).toBe(1);
	});

	test("search indexes canonical main content before raw HTML source", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun(
			"crawl-main-content-search",
			createCrawlOptionsFixture({ target: "https://main-content.example" }),
		);

		persistPageFixture(storage, {
			crawlId: created.id,
			url: "https://main-content.example/page",
			title: "Canonical source",
			content: "<script>uniquerawonlyneedle()</script>",
			mainContent: "uniquemainonlyneedle body",
		});

		expect(storage.repos.search.count(created.id, '"uniquemainonlyneedle"*')).toBe(1);
		expect(storage.repos.search.count(created.id, '"uniquerawonlyneedle"*')).toBe(0);
	});

	test("metadata-only search matches return non-empty snippets", () => {
		const storage = createInMemoryStorage();
		const created = storage.repos.crawlRuns.createRun(
			"crawl-metadata-search",
			createCrawlOptionsFixture({ target: "https://metadata.example", contentOnly: true }),
		);

		persistPageFixture(storage, {
			crawlId: created.id,
			url: "https://metadata.example/title",
			title: "uniquetitleonlyneedle",
		});
		persistPageFixture(storage, {
			crawlId: created.id,
			url: "https://metadata.example/description",
			description: "uniquedescriptiononlyneedle",
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
		const created = storage.repos.crawlRuns.createRun(
			"crawl-metadata-snippet-priority",
			createCrawlOptionsFixture({ target: "https://metadata-snippet.example" }),
		);

		persistPageFixture(storage, {
			crawlId: created.id,
			url: "https://metadata-snippet.example/title",
			title: "uniquetitlesnippetneedle",
			content: "<main>unrelated body text should not become the snippet</main>",
			mainContent: "unrelated body text should not become the snippet",
		});

		const result = storage.repos.search.search(created.id, '"uniquetitlesnippetneedle"*', 10)[0];

		expect(result?.snippet).toContain("uniquetitlesnippetneedle");
		expect(result?.snippet).not.toContain("unrelated body text");
	});

	test("item completion commits once and rejects duplicate page rewrites transactionally", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun(
			"crawl-item",
			createCrawlOptionsFixture({ target: "https://item.example/page" }),
		);
		expect(storage.repos.crawlQueue.listPending("crawl-item")).toEqual([
			expect.objectContaining({ url: "https://item.example/page" }),
		]);
		const page = {
			contentType: "text/html",
			contentLength: 2048,
			title: "Item page",
			description: "Item description",
			content: "<main>Item</main>",
			mainContent: "Item",
			wordCount: 1,
			readingTime: 1,
			language: "en",
			mediaCount: 2,
			discoveredLinkCount: 3,
		};
		const result = storage.repos.crawlItems.commitCompletedItem({
			crawlId: "crawl-item",
			url: "https://item.example/page",
			outcome: "success",
			domainBudgetCharged: true,
			page,
			eventSequence: 7,
		});

		expect(result.type).toBe("page-persisted");
		if (result.type !== "page-persisted") {
			throw new Error("Expected the page-persisted completion variant");
		}
		expect(result.pageId).toBeGreaterThan(0);
		expect(result.pageCount).toBe(1);
		expect(result.counters).toEqual({
			pagesScanned: 1,
			successCount: 1,
			failureCount: 0,
			skippedCount: 0,
			linksFound: 3,
			mediaFiles: 2,
			totalDataKb: 2,
		});
		expect(Array.from(storage.repos.pages.iterateForExport("crawl-item"))).toHaveLength(1);
		expect(storage.repos.pages.listSnapshot("crawl-item").pages[0]?.details).toEqual({
			wordCount: 1,
			readingTime: 1,
			language: "en",
		});
		expect(storage.repos.crawlItems.listTerminalUrls("crawl-item")).toEqual([
			{
				url: "https://item.example/page",
				outcome: "success",
				domainBudgetCharged: true,
				chargedDomain: "item.example",
			},
		]);
		expect(storage.repos.crawlQueue.listPending("crawl-item")).toEqual([]);
		expect(storage.repos.crawlRuns.getById("crawl-item")?.eventSequence).toBe(7);

		expect(() =>
			storage.repos.crawlQueue.enqueueMany("crawl-item", [
				{
					url: "https://item.example/page",
					depth: 0,
					retries: 0,
					domain: "item.example",
				},
			]),
		).toThrow("cannot queue a terminal crawl URL");
		expect(() =>
			storage.repos.crawlItems.commitCompletedItem({
				crawlId: "crawl-item",
				url: "https://item.example/page",
				outcome: "success",
				domainBudgetCharged: true,
				chargedDomain: "item.example",
				page: { ...page, title: "Duplicate item page" },
				eventSequence: 8,
			}),
		).toThrow();
		expect(() =>
			storage.repos.crawlItems.commitCompletedItem({
				crawlId: "crawl-item",
				url: "https://item.example/never-queued",
				outcome: "failure",
				domainBudgetCharged: true,
				eventSequence: 8,
			}),
		).toThrow("Cannot complete non-pending crawl URL: https://item.example/never-queued");

		expect(storage.repos.crawlQueue.listPending("crawl-item")).toEqual([]);
		expect(storage.repos.crawlRuns.getById("crawl-item")?.eventSequence).toBe(7);
		expect(Array.from(storage.repos.pages.iterateForExport("crawl-item"))).toEqual([
			expect.objectContaining({ id: result.pageId, title: "Item page" }),
		]);
		expect(storage.repos.crawlItems.listTerminalUrls("crawl-item")).toEqual([
			{
				url: "https://item.example/page",
				outcome: "success",
				domainBudgetCharged: true,
				chargedDomain: "item.example",
			},
		]);
	});

	test("terminal URL restore order follows insertion sequence inside one timestamp", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun(
			"crawl-terminal-order",
			createCrawlOptionsFixture({ target: "https://order.example" }),
		);

		storage.repos.crawlQueue.enqueueMany("crawl-terminal-order", [
			{
				url: "https://order.example/z-skip",
				depth: 0,
				retries: 0,
				domain: "order.example",
			},
			{
				url: "https://order.example/a-failure",
				depth: 0,
				retries: 0,
				domain: "order.example",
			},
		]);
		storage.repos.crawlItems.commitCompletedItem({
			crawlId: "crawl-terminal-order",
			url: "https://order.example/z-skip",
			outcome: "skip",
			domainBudgetCharged: true,
			eventSequence: 1,
		});
		storage.repos.crawlItems.commitCompletedItem({
			crawlId: "crawl-terminal-order",
			url: "https://order.example/a-failure",
			outcome: "failure",
			domainBudgetCharged: false,
			eventSequence: 2,
		});

		expect(storage.repos.crawlItems.listTerminalUrls("crawl-terminal-order")).toEqual([
			{
				url: "https://order.example/z-skip",
				outcome: "skip",
				domainBudgetCharged: true,
				chargedDomain: "order.example",
			},
			{
				url: "https://order.example/a-failure",
				outcome: "failure",
				domainBudgetCharged: false,
				chargedDomain: null,
			},
		]);
	});

	test("item completion rolls back terminal and page inserts when a later projection fails", () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlRuns.createRun(
			"crawl-item-rollback",
			createCrawlOptionsFixture({ target: "https://rollback.example" }),
		);
		storage.repos.crawlQueue.enqueueMany("crawl-item-rollback", [
			{
				url: "https://rollback.example/page",
				depth: 0,
				retries: 0,
				domain: "rollback.example",
			},
		]);

		expect(() =>
			storage.repos.crawlItems.commitCompletedItem({
				crawlId: "crawl-item-rollback",
				url: "https://rollback.example/page",
				outcome: "success",
				domainBudgetCharged: true,
				page: {
					contentType: "text/html",
					contentLength: 100,
					title: "Rollback page",
					description: "",
					content: "<main>Rollback</main>",
					mainContent: "Rollback",
					wordCount: 0,
					readingTime: 0,
					language: "unknown",
					mediaCount: 0,
					discoveredLinkCount: 0,
				},
				eventSequence: -1,
			}),
		).toThrow();

		expect(Array.from(storage.repos.pages.iterateForExport("crawl-item-rollback"))).toEqual([]);
		expect(storage.repos.crawlItems.listTerminalUrls("crawl-item-rollback")).toEqual([]);
		expect(
			storage.repos.crawlQueue.listPending("crawl-item-rollback").map((item) => item.url),
		).toEqual(["https://rollback.example/", "https://rollback.example/page"]);
		expect(storage.repos.crawlRuns.getById("crawl-item-rollback")?.eventSequence).toBe(0);
	});
});

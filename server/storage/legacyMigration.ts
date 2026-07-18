import type { Database } from "bun:sqlite";
import type { CrawlCounters, CrawlOptions } from "../../shared/contracts/index.js";
import { isCrawlOptions, normalizeCrawlOptions } from "../../shared/contracts/index.js";
import { CRAWL_OPTION_BOUNDS, isCrawlMethod } from "../../shared/crawl.js";
import { normalizeCanonicalHttpUrl } from "../../shared/url.js";

const LEGACY_TABLES = [
	"pages",
	"links",
	"domain_settings",
	"crawl_sessions",
	"queue_items",
] as const;
const LEGACY_PREFIX = "legacy_v0_";
const LEGACY_ARCHIVE_TARGET = "https://legacy.invalid/";

const DEFAULT_LEGACY_OPTIONS: Omit<CrawlOptions, "target"> = {
	crawlMethod: "full",
	crawlDepth: 2,
	crawlDelay: 1000,
	maxPages: 50,
	maxPagesPerDomain: 0,
	maxConcurrentRequests: 5,
	retryLimit: 3,
	dynamic: true,
	respectRobots: true,
	contentOnly: false,
	saveMedia: false,
};

type SqliteRow = Record<string, unknown>;

export interface LegacyArchiveState {
	present: boolean;
	archivedPages: boolean;
}

function tableExists(db: Database, tableName: string): boolean {
	return (
		db
			.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
			.get(tableName) !== null
	);
}

function tableColumns(db: Database, tableName: string): Set<string> {
	if (!tableExists(db, tableName)) return new Set();
	return new Set(
		(db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map(
			(column) => column.name,
		),
	);
}

function hasColumn(db: Database, tableName: string, columnName: string): boolean {
	return tableColumns(db, tableName).has(columnName);
}

function dropLegacyPageIndexes(db: Database): void {
	for (const indexName of [
		"idx_pages_domain",
		"idx_pages_crawled_at",
		"idx_pages_url",
		"idx_pages_language",
		"idx_pages_quality_score",
		"idx_pages_word_count",
		"idx_pages_domain_crawled",
		"idx_pages_crawled_id",
		"idx_links_source",
		"idx_links_target",
	]) {
		db.exec(`DROP INDEX IF EXISTS ${indexName}`);
	}
}

function renameLegacyTable(db: Database, tableName: (typeof LEGACY_TABLES)[number]): void {
	if (!tableExists(db, tableName)) return;
	const archiveName = `${LEGACY_PREFIX}${tableName}`;
	if (tableExists(db, archiveName)) {
		throw new Error(
			`Cannot migrate legacy table ${tableName}: archive table ${archiveName} exists`,
		);
	}
	if (tableName === "pages" && hasColumn(db, tableName, "crawl_id")) return;
	db.exec(`ALTER TABLE ${tableName} RENAME TO ${archiveName}`);
}

/**
 * Moves the pre-migration global schema out of the current namespace. The
 * archived tables are retained as a lossless source record; current code has
 * no read path to them after their durable projections are imported.
 */
export function archiveLegacySchema(db: Database): LegacyArchiveState {
	const archivedPages = tableExists(db, "pages") && !hasColumn(db, "pages", "crawl_id");
	const legacyNamedTablesPresent = [
		"links",
		"domain_settings",
		"crawl_sessions",
		"queue_items",
	].some((tableName) => tableExists(db, tableName));
	if (!archivedPages && !legacyNamedTablesPresent) {
		return { present: false, archivedPages: false };
	}

	if (archivedPages) {
		db.exec(`
			DROP TRIGGER IF EXISTS pages_fts_ai;
			DROP TRIGGER IF EXISTS pages_fts_ad;
			DROP TRIGGER IF EXISTS pages_fts_au;
			DROP TRIGGER IF EXISTS pages_ai;
			DROP TRIGGER IF EXISTS pages_ad;
			DROP TRIGGER IF EXISTS pages_au;
			DROP TABLE IF EXISTS pages_fts;
		`);
		dropLegacyPageIndexes(db);
	}

	db.exec(`
		DROP INDEX IF EXISTS idx_sessions_status;
		DROP INDEX IF EXISTS idx_queue_items_session;
	`);

	for (const tableName of LEGACY_TABLES) {
		renameLegacyTable(db, tableName);
	}

	return { present: true, archivedPages };
}

/** Brings every accepted historical migration outcome up to the 0006 input shape. */
export function prepareCanonicalMigrationColumns(db: Database): void {
	for (const row of db.query("SELECT id, target, options_json FROM crawl_runs").all() as Array<{
		id: string;
		target: string;
		options_json: string;
	}>) {
		const rawOptions = parseRecord(row.options_json);
		if (!rawOptions) {
			throw new Error(`Cannot migrate crawl run ${row.id}: options JSON is invalid`);
		}
		const normalizedTarget = normalizedLegacyUrl(rawOptions.target ?? row.target, "");
		if (!normalizedTarget) {
			throw new Error(`Cannot migrate crawl run ${row.id}: target URL is invalid`);
		}
		const normalizedOptions = legacyOptions(row.id, normalizedTarget, row.options_json);
		if (!isCrawlOptions(normalizedOptions)) {
			throw new Error(
				`Cannot migrate crawl run ${row.id}: options are outside the current contract`,
			);
		}
		db.query("UPDATE crawl_runs SET target = ?, options_json = ? WHERE id = ?").run(
			normalizedOptions.target,
			JSON.stringify(normalizedOptions),
			row.id,
		);
	}

	if (!hasColumn(db, "crawl_queue_items", "available_at")) {
		db.exec(
			"ALTER TABLE crawl_queue_items ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0 CHECK(available_at >= 0)",
		);
	}
	if (!hasColumn(db, "page_links", "nofollow")) {
		db.exec(
			"ALTER TABLE page_links ADD COLUMN nofollow INTEGER NOT NULL DEFAULT 0 CHECK(nofollow IN (0, 1))",
		);
	}
	if (!hasColumn(db, "pages", "discovered_links_count")) {
		db.exec(
			"ALTER TABLE pages ADD COLUMN discovered_links_count INTEGER NOT NULL DEFAULT 0 CHECK(discovered_links_count >= 0)",
		);
	}

	if (!tableExists(db, "crawl_terminal_urls")) {
		db.exec(`
			CREATE TABLE crawl_terminal_urls (
				terminal_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				crawl_id TEXT NOT NULL,
				url TEXT NOT NULL,
				outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'skip')),
				domain_budget_charged INTEGER NOT NULL DEFAULT 0 CHECK(domain_budget_charged IN (0, 1)),
				recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				UNIQUE (crawl_id, url),
				FOREIGN KEY (crawl_id) REFERENCES crawl_runs(id) ON DELETE CASCADE
			);
			INSERT OR IGNORE INTO crawl_terminal_urls (crawl_id, url, outcome, domain_budget_charged)
			SELECT crawl_id, url, 'success', 1 FROM pages;
		`);
	}
	if (!hasColumn(db, "crawl_terminal_urls", "terminal_sequence")) {
		db.exec("ALTER TABLE crawl_terminal_urls ADD COLUMN terminal_sequence INTEGER");
	}
	if (!hasColumn(db, "crawl_terminal_urls", "domain_budget_charged")) {
		db.exec(
			"ALTER TABLE crawl_terminal_urls ADD COLUMN domain_budget_charged INTEGER NOT NULL DEFAULT 0",
		);
	}
	db.exec(`
		UPDATE crawl_terminal_urls
		SET terminal_sequence = rowid
		WHERE terminal_sequence IS NULL;

		UPDATE crawl_terminal_urls
		SET domain_budget_charged = 1
		WHERE outcome = 'success'
		  AND EXISTS (
			SELECT 1
			FROM pages
			WHERE pages.crawl_id = crawl_terminal_urls.crawl_id
			  AND pages.url = crawl_terminal_urls.url
		  );
	`);

	if (!tableExists(db, "crawl_domain_state")) {
		db.exec(`
			CREATE TABLE crawl_domain_state (
				crawl_id TEXT NOT NULL,
				delay_key TEXT NOT NULL,
				delay_ms INTEGER NOT NULL CHECK(delay_ms >= 0),
				next_allowed_at INTEGER NOT NULL CHECK(next_allowed_at >= 0),
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				PRIMARY KEY (crawl_id, delay_key),
				FOREIGN KEY (crawl_id) REFERENCES crawl_runs(id) ON DELETE CASCADE
			);
		`);
	}
	db.exec(`
		UPDATE crawl_domain_state
		SET delay_ms = 60000
		WHERE delay_ms > 60000;
	`);
}

function asRecord(value: unknown): SqliteRow | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as SqliteRow)
		: null;
}

function parseRecord(value: unknown): SqliteRow | null {
	if (typeof value !== "string") return null;
	try {
		return asRecord(JSON.parse(value));
	} catch {
		return null;
	}
}

function safeInteger(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(max, Math.max(min, Math.round(value)))
		: fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function textValue(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function nullableText(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function normalizedLegacyUrl(value: unknown, fallback: string): string {
	if (typeof value === "string") {
		const normalized = normalizeCanonicalHttpUrl(value);
		if (!("error" in normalized)) return normalized.url;
	}
	return fallback;
}

function legacyOptions(
	sessionId: string,
	targetValue: unknown,
	encodedOptions: unknown,
): CrawlOptions {
	const raw = parseRecord(encodedOptions) ?? {};
	const fallbackTarget = `${LEGACY_ARCHIVE_TARGET}session/${encodeURIComponent(sessionId)}`;
	const target = normalizedLegacyUrl(targetValue ?? raw.target, fallbackTarget);
	const method =
		typeof raw.crawlMethod === "string" && isCrawlMethod(raw.crawlMethod)
			? raw.crawlMethod
			: DEFAULT_LEGACY_OPTIONS.crawlMethod;

	return normalizeCrawlOptions({
		target,
		crawlMethod: method,
		crawlDepth: boundedInteger(
			raw.crawlDepth,
			CRAWL_OPTION_BOUNDS.crawlDepth.min,
			CRAWL_OPTION_BOUNDS.crawlDepth.max,
			DEFAULT_LEGACY_OPTIONS.crawlDepth,
		),
		crawlDelay: boundedInteger(
			raw.crawlDelay,
			CRAWL_OPTION_BOUNDS.crawlDelay.min,
			CRAWL_OPTION_BOUNDS.crawlDelay.max,
			DEFAULT_LEGACY_OPTIONS.crawlDelay,
		),
		maxPages: boundedInteger(
			raw.maxPages,
			CRAWL_OPTION_BOUNDS.maxPages.min,
			CRAWL_OPTION_BOUNDS.maxPages.max,
			DEFAULT_LEGACY_OPTIONS.maxPages,
		),
		maxPagesPerDomain: boundedInteger(
			raw.maxPagesPerDomain,
			CRAWL_OPTION_BOUNDS.maxPagesPerDomain.min,
			CRAWL_OPTION_BOUNDS.maxPagesPerDomain.max,
			DEFAULT_LEGACY_OPTIONS.maxPagesPerDomain,
		),
		maxConcurrentRequests: boundedInteger(
			raw.maxConcurrentRequests,
			CRAWL_OPTION_BOUNDS.maxConcurrentRequests.min,
			CRAWL_OPTION_BOUNDS.maxConcurrentRequests.max,
			DEFAULT_LEGACY_OPTIONS.maxConcurrentRequests,
		),
		retryLimit: boundedInteger(
			raw.retryLimit,
			CRAWL_OPTION_BOUNDS.retryLimit.min,
			CRAWL_OPTION_BOUNDS.retryLimit.max,
			DEFAULT_LEGACY_OPTIONS.retryLimit,
		),
		dynamic: booleanValue(raw.dynamic, DEFAULT_LEGACY_OPTIONS.dynamic),
		respectRobots: booleanValue(raw.respectRobots, DEFAULT_LEGACY_OPTIONS.respectRobots),
		contentOnly: booleanValue(raw.contentOnly, DEFAULT_LEGACY_OPTIONS.contentOnly),
		saveMedia: booleanValue(raw.saveMedia, DEFAULT_LEGACY_OPTIONS.saveMedia),
	});
}

function completedLegacyCounters(encodedStats: unknown): CrawlCounters {
	const stats = parseRecord(encodedStats) ?? {};
	const successCount = safeInteger(stats.successCount);
	const failureCount = safeInteger(stats.failureCount);
	const skippedCount = safeInteger(stats.skippedCount);
	return {
		pagesScanned: successCount + failureCount + skippedCount,
		successCount,
		failureCount,
		skippedCount,
		linksFound: safeInteger(stats.linksFound),
		mediaFiles: safeInteger(stats.mediaFiles),
		totalDataKb: safeInteger(stats.totalDataKb ?? stats.totalData),
	};
}

function uniqueCrawlId(db: Database, requestedId: string): string {
	let candidate = requestedId;
	let suffix = 0;
	while (db.query("SELECT 1 FROM crawl_runs WHERE id = ? LIMIT 1").get(candidate) !== null) {
		suffix += 1;
		candidate = `${requestedId}-legacy-${suffix}`;
	}
	return candidate;
}

function importLegacyPages(db: Database): void {
	if (!tableExists(db, `${LEGACY_PREFIX}pages`)) return;
	const rows = db.query(`SELECT * FROM ${LEGACY_PREFIX}pages ORDER BY id`).all() as SqliteRow[];
	if (rows.length === 0) return;

	const crawlId = uniqueCrawlId(db, "legacy-v0-unscoped-pages");
	const options: CrawlOptions = { target: LEGACY_ARCHIVE_TARGET, ...DEFAULT_LEGACY_OPTIONS };
	const createdAt = textValue(rows[0]?.crawled_at, new Date(0).toISOString());
	const updatedAt = textValue(rows.at(-1)?.crawled_at, createdAt);
	const insertRun = db.prepare(`
		INSERT INTO crawl_runs (
			id, target, status, stop_reason, options_json, created_at, started_at, updated_at,
			completed_at, pages_scanned, success_count, failure_count, skipped_count,
			links_found, media_files, total_data_kb, event_sequence
		) VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 0)
	`);
	const totalMedia = rows.reduce((total, row) => total + safeInteger(row.media_count), 0);
	const totalDataKb = rows.reduce(
		(total, row) => total + Math.ceil(safeInteger(row.data_length) / 1024),
		0,
	);
	insertRun.run(
		crawlId,
		options.target,
		"Imported from the pre-run-scoped page store",
		JSON.stringify(options),
		createdAt,
		createdAt,
		updatedAt,
		updatedAt,
		rows.length,
		rows.length,
		totalMedia,
		totalDataKb,
	);

	const insertPage = db.prepare(`
		INSERT INTO pages (
			id, crawl_id, url, domain, crawled_at, last_modified, etag, content_type,
			status_code, data_length, title, description, content, is_dynamic, main_content,
			word_count, reading_time, language, keywords, quality_score, structured_data,
			media_count, internal_links_count, external_links_count, discovered_links_count
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
	`);
	const oldToNewPageIds = new Map<number, number>();
	for (const row of rows) {
		const oldId = safeInteger(row.id);
		const url = normalizedLegacyUrl(row.url, `${LEGACY_ARCHIVE_TARGET}page/${oldId}`);
		const domain = textValue(row.domain, new URL(url).hostname);
		const requestedId =
			oldId > 0 && db.query("SELECT 1 FROM pages WHERE id = ?").get(oldId) === null ? oldId : null;
		const result = insertPage.run(
			requestedId,
			crawlId,
			url,
			domain,
			textValue(row.crawled_at, createdAt),
			nullableText(row.last_modified),
			nullableText(row.etag),
			nullableText(row.content_type),
			typeof row.status_code === "number" ? row.status_code : null,
			typeof row.data_length === "number" ? row.data_length : null,
			nullableText(row.title),
			nullableText(row.description),
			nullableText(row.content),
			row.is_dynamic === 1 ? 1 : 0,
			nullableText(row.main_content),
			typeof row.word_count === "number" && row.word_count >= 0 ? row.word_count : null,
			typeof row.reading_time === "number" && row.reading_time >= 0 ? row.reading_time : null,
			nullableText(row.language),
			nullableText(row.keywords),
			typeof row.quality_score === "number" && row.quality_score >= 0 ? row.quality_score : null,
			nullableText(row.structured_data),
			safeInteger(row.media_count),
			safeInteger(row.internal_links_count),
			safeInteger(row.external_links_count),
		);
		const newId = requestedId ?? Number(result.lastInsertRowid);
		oldToNewPageIds.set(oldId, newId);
		db.query(
			"INSERT INTO crawl_terminal_urls (crawl_id, url, outcome, domain_budget_charged) VALUES (?, ?, 'success', 1)",
		).run(crawlId, url);
	}

	if (!tableExists(db, `${LEGACY_PREFIX}links`)) return;
	const insertLink = db.prepare(
		"INSERT OR IGNORE INTO page_links (page_id, target_url, text, nofollow) VALUES (?, ?, ?, 0)",
	);
	for (const row of db
		.query(`SELECT * FROM ${LEGACY_PREFIX}links ORDER BY id`)
		.all() as SqliteRow[]) {
		const pageId = oldToNewPageIds.get(safeInteger(row.source_id));
		if (pageId === undefined || typeof row.target_url !== "string") continue;
		insertLink.run(pageId, row.target_url, typeof row.text === "string" ? row.text : "");
	}
}

function importLegacySessions(db: Database): void {
	if (!tableExists(db, `${LEGACY_PREFIX}crawl_sessions`)) return;
	const queueRows = tableExists(db, `${LEGACY_PREFIX}queue_items`)
		? (db.query(`SELECT * FROM ${LEGACY_PREFIX}queue_items ORDER BY id`).all() as SqliteRow[])
		: [];
	const queuesBySession = new Map<string, SqliteRow[]>();
	for (const row of queueRows) {
		if (typeof row.session_id !== "string") continue;
		const rows = queuesBySession.get(row.session_id) ?? [];
		rows.push(row);
		queuesBySession.set(row.session_id, rows);
	}

	const insertQueue = db.prepare(`
		INSERT INTO crawl_queue_items
			(crawl_id, url, depth, retries, parent_url, domain, available_at)
		VALUES (?, ?, ?, ?, ?, ?, 0)
	`);
	for (const row of db
		.query(`SELECT * FROM ${LEGACY_PREFIX}crawl_sessions ORDER BY created_at`)
		.all() as SqliteRow[]) {
		const legacyId = textValue(row.id, crypto.randomUUID());
		const id = uniqueCrawlId(db, legacyId);
		const options = legacyOptions(legacyId, row.target, row.options);
		const validQueue = (queuesBySession.get(legacyId) ?? []).flatMap((item) => {
			if (typeof item.url !== "string") return [];
			const normalized = normalizeCanonicalHttpUrl(item.url);
			if ("error" in normalized) return [];
			return [
				{
					url: normalized.url,
					depth: boundedInteger(item.depth, 0, CRAWL_OPTION_BOUNDS.crawlDepth.max, 0),
					retries: boundedInteger(item.retries, 0, CRAWL_OPTION_BOUNDS.retryLimit.max, 0),
					parentUrl:
						typeof item.parent_url === "string"
							? normalizedLegacyUrl(item.parent_url, options.target)
							: null,
					domain: new URL(normalized.url).hostname,
				},
			];
		});
		const migratedQueueUrls = new Set<string>();
		const migratedQueue = validQueue.filter((item) => {
			if (migratedQueueUrls.has(item.url)) return false;
			migratedQueueUrls.add(item.url);
			return true;
		});
		const legacyStatus = typeof row.status === "string" ? row.status : "interrupted";
		const status =
			legacyStatus === "completed"
				? "completed"
				: migratedQueue.length > 0
					? "interrupted"
					: "failed";
		const counters =
			status === "completed"
				? completedLegacyCounters(row.stats)
				: {
						pagesScanned: 0,
						successCount: 0,
						failureCount: 0,
						skippedCount: 0,
						linksFound: 0,
						mediaFiles: 0,
						totalDataKb: 0,
					};
		const createdAt = textValue(row.created_at, new Date(0).toISOString());
		const updatedAt = textValue(row.updated_at, createdAt);
		const stopReason =
			status === "interrupted"
				? "Migrated from legacy resumable session state"
				: status === "failed"
					? "Legacy session had no valid resumable queue"
					: null;

		db.query(`
			INSERT INTO crawl_runs (
				id, target, status, stop_reason, options_json, created_at, started_at, updated_at,
				completed_at, pages_scanned, success_count, failure_count, skipped_count,
				links_found, media_files, total_data_kb, event_sequence
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		`).run(
			id,
			options.target,
			status,
			stopReason,
			JSON.stringify(options),
			createdAt,
			createdAt,
			updatedAt,
			status === "interrupted" ? null : updatedAt,
			counters.pagesScanned,
			counters.successCount,
			counters.failureCount,
			counters.skippedCount,
			counters.linksFound,
			counters.mediaFiles,
			counters.totalDataKb,
		);

		if (status === "interrupted") {
			for (const item of migratedQueue) {
				insertQueue.run(id, item.url, item.depth, item.retries, item.parentUrl, item.domain);
			}
		}
	}
}

export function importArchivedLegacyData(db: Database, state: LegacyArchiveState): void {
	if (!state.present) return;
	importLegacyPages(db);
	importLegacySessions(db);
}

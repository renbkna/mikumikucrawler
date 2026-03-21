import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config/env.js";
import type { CrawlOptions, CrawlStatus } from "../contracts/crawl.js";
import { createCrawlQueueRepo } from "./repos/crawlQueueRepo.js";
import { createCrawlRunRepo } from "./repos/crawlRunRepo.js";
import { createPageRepo } from "./repos/pageRepo.js";
import { createSearchRepo } from "./repos/searchRepo.js";
import { createStatsRepo } from "./repos/statsRepo.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDirectory = path.join(__dirname, "migrations");

export interface StorageRepos {
	crawlRuns: ReturnType<typeof createCrawlRunRepo>;
	crawlQueue: ReturnType<typeof createCrawlQueueRepo>;
	pages: ReturnType<typeof createPageRepo>;
	search: ReturnType<typeof createSearchRepo>;
	stats: ReturnType<typeof createStatsRepo>;
}

export interface Storage {
	db: Database;
	repos: StorageRepos;
}

function ensureDatabaseDirectory(databasePath: string): void {
	if (databasePath === ":memory:") return;
	const directory = path.dirname(databasePath);
	if (!existsSync(directory)) {
		mkdirSync(directory, { recursive: true });
	}
}

function configurePragmas(db: Database): void {
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA cache_size = -16000;
		PRAGMA temp_store = MEMORY;
		PRAGMA mmap_size = 67108864;
		PRAGMA busy_timeout = 5000;
		PRAGMA foreign_keys = ON;
	`);
}

export function applyMigrations(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			id TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`);

	const applied = new Set(
		(
			db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{
				id: string;
			}>
		).map((row) => row.id),
	);

	const insertMigration = db.prepare(
		"INSERT INTO schema_migrations (id) VALUES (?)",
	);

	for (const fileName of readdirSync(migrationsDirectory).sort()) {
		if (!fileName.endsWith(".sql") || applied.has(fileName)) {
			continue;
		}

		const sql = readFileSync(path.join(migrationsDirectory, fileName), "utf8");
		db.exec(sql);
		insertMigration.run(fileName);
	}
}

export function createStorage(databasePath = config.dbPath): Storage {
	ensureDatabaseDirectory(databasePath);
	const db = new Database(databasePath);
	configurePragmas(db);
	applyMigrations(db);

	return {
		db,
		repos: {
			crawlRuns: createCrawlRunRepo(db),
			crawlQueue: createCrawlQueueRepo(db),
			pages: createPageRepo(db),
			search: createSearchRepo(db),
			stats: createStatsRepo(db),
		},
	};
}

export function createInMemoryStorage(): Storage {
	return createStorage(":memory:");
}

export interface CrawlRunRow {
	id: string;
	target: string;
	status: CrawlStatus;
	stop_reason: string | null;
	options_json: string;
	created_at: string;
	started_at: string | null;
	updated_at: string;
	completed_at: string | null;
	pages_scanned: number;
	success_count: number;
	failure_count: number;
	skipped_count: number;
	links_found: number;
	media_files: number;
	total_data_kb: number;
	event_sequence: number;
}

export interface CrawlRunRecord {
	id: string;
	target: string;
	status: CrawlStatus;
	options: CrawlOptions;
	stopReason: string | null;
	createdAt: string;
	startedAt: string | null;
	updatedAt: string;
	completedAt: string | null;
	counters: {
		pagesScanned: number;
		successCount: number;
		failureCount: number;
		skippedCount: number;
		linksFound: number;
		mediaFiles: number;
		totalDataKb: number;
	};
	eventSequence: number;
	resumable: boolean;
}

function toIsoDateTime(value: string | null): string | null {
	if (!value) {
		return null;
	}

	return value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
}

export function mapCrawlRunRow(row: CrawlRunRow): CrawlRunRecord {
	return {
		id: row.id,
		target: row.target,
		status: row.status,
		options: JSON.parse(row.options_json) as CrawlOptions,
		stopReason: row.stop_reason,
		createdAt: toIsoDateTime(row.created_at) ?? row.created_at,
		startedAt: toIsoDateTime(row.started_at),
		updatedAt: toIsoDateTime(row.updated_at) ?? row.updated_at,
		completedAt: toIsoDateTime(row.completed_at),
		counters: {
			pagesScanned: row.pages_scanned,
			successCount: row.success_count,
			failureCount: row.failure_count,
			skippedCount: row.skipped_count,
			linksFound: row.links_found,
			mediaFiles: row.media_files,
			totalDataKb: row.total_data_kb,
		},
		eventSequence: row.event_sequence,
		resumable: row.status === "interrupted",
	};
}

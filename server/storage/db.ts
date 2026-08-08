import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CrawlOptions, CrawlStatus } from "../../shared/contracts/index.js";
import {
	isCrawlCounters,
	isCrawlOptions,
	isResumableCrawlStatus,
} from "../../shared/contracts/index.js";
import { bytesToKilobytes } from "../../shared/text.js";
import { config } from "../config/env.js";
import { DurableStorageBudget } from "./DurableStorageBudget.js";
import { canonicalizeStorageDateTime } from "./dateTime.js";
import { createCrawlDomainStateRepo } from "./repos/crawlDomainStateRepo.js";
import { createCrawlItemPersistence } from "./repos/crawlItemPersistence.js";
import { createCrawlQueueRepo } from "./repos/crawlQueueRepo.js";
import { createCrawlRunRepo } from "./repos/crawlRunRepo.js";
import { createPageRepo } from "./repos/pageRepo.js";
import { createSearchRepo } from "./repos/searchRepo.js";

const moduleFilename = fileURLToPath(import.meta.url);
const moduleDirectory = path.dirname(moduleFilename);
const migrationsDirectory = path.join(moduleDirectory, "migrations");

export interface StorageRepos {
	crawlRuns: ReturnType<typeof createCrawlRunRepo>;
	crawlQueue: ReturnType<typeof createCrawlQueueRepo>;
	crawlItems: ReturnType<typeof createCrawlItemPersistence>;
	crawlDomainState: ReturnType<typeof createCrawlDomainStateRepo>;
	pages: ReturnType<typeof createPageRepo>;
	search: ReturnType<typeof createSearchRepo>;
}

export interface Storage {
	db: Database;
	repos: StorageRepos;
	budget: DurableStorageBudget;
	close(): void;
}

export type OwnStatement = <T extends { finalize(): void }>(statement: T) => T;

export interface CreateStorageOptions {
	maxBytes?: number;
	pageReservationBytes?: number;
}

function ensureDatabaseDirectory(databasePath: string): void {
	if (databasePath === ":memory:") return;
	const directory = path.dirname(databasePath);
	if (!existsSync(directory)) {
		mkdirSync(directory, { recursive: true });
	}
}

export class DatabaseOwnershipError extends Error {
	constructor(databasePath: string, options?: ErrorOptions) {
		super(`Database is already owned by another crawler process: ${databasePath}`, options);
		this.name = "DatabaseOwnershipError";
	}
}

function configurePragmas(db: Database, databasePath: string): void {
	db.exec(`
		PRAGMA busy_timeout = 0;
		PRAGMA locking_mode = EXCLUSIVE;
	`);
	try {
		db.exec("BEGIN EXCLUSIVE");
		db.exec("COMMIT");
	} catch (error) {
		if (db.inTransaction) db.exec("ROLLBACK");
		throw new DatabaseOwnershipError(databasePath, { cause: error });
	}

	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA cache_size = -16000;
		PRAGMA temp_store = FILE;
		PRAGMA mmap_size = 67108864;
		PRAGMA busy_timeout = 5000;
		PRAGMA foreign_keys = ON;
	`);
}

function migrationChecksum(sql: string): string {
	return createHash("sha256").update(sql).digest("hex");
}

export function applyMigrations(db: Database, migrationDirectory = migrationsDirectory): void {
	const migrationFiles = readdirSync(migrationDirectory)
		.filter((fileName) => fileName.endsWith(".sql"))
		.sort();
	const knownMigrationIds = new Set(migrationFiles);

	db.transaction(() => {
		db.exec(`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				id TEXT PRIMARY KEY,
				applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				checksum TEXT NOT NULL
			)
		`);

		const ledgerRows = db
			.query("SELECT id, checksum FROM schema_migrations ORDER BY id")
			.all() as Array<{ id: string; checksum: string }>;
		const unknownAppliedMigration = ledgerRows.find((row) => !knownMigrationIds.has(row.id));
		if (unknownAppliedMigration !== undefined) {
			throw new Error(
				`Applied migration ${unknownAppliedMigration.id} is not present in this release lineage`,
			);
		}
		for (const [index, row] of ledgerRows.entries()) {
			if (migrationFiles[index] !== row.id) {
				throw new Error(
					`Applied migrations must form an ordered prefix; found ${row.id} at position ${index + 1}`,
				);
			}
		}
		const applied = new Map(ledgerRows.map((row) => [row.id, row.checksum] as const));
		const insertMigration = db.prepare(
			"INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)",
		);
		try {
			for (const fileName of migrationFiles) {
				const sql = readFileSync(path.join(migrationDirectory, fileName), "utf8");
				const checksum = migrationChecksum(sql);
				const appliedChecksum = applied.get(fileName);
				if (appliedChecksum !== undefined) {
					if (appliedChecksum !== checksum) {
						throw new Error(
							`Applied migration ${fileName} checksum mismatch; database was migrated with different SQL`,
						);
					}
					continue;
				}

				db.exec(sql);
				insertMigration.run(fileName, checksum);
			}
		} finally {
			insertMigration.finalize();
		}
	})();
}

export function createStorage(
	databasePath = config.dbPath,
	options: CreateStorageOptions = {},
): Storage {
	ensureDatabaseDirectory(databasePath);
	const db = new Database(databasePath);
	const ownedStatements: Array<{ finalize(): void }> = [];
	const ownStatement: OwnStatement = (statement) => {
		ownedStatements.push(statement);
		return statement;
	};
	try {
		configurePragmas(db, databasePath);
		applyMigrations(db);
		let closed = false;

		return {
			db,
			budget: new DurableStorageBudget(db, {
				maxBytes: options.maxBytes ?? config.maxStorageBytes,
				...(options.pageReservationBytes === undefined
					? {}
					: { pageReservationBytes: options.pageReservationBytes }),
			}),
			repos: {
				crawlRuns: createCrawlRunRepo(db, ownStatement),
				crawlQueue: createCrawlQueueRepo(db, ownStatement),
				crawlItems: createCrawlItemPersistence(db, ownStatement),
				crawlDomainState: createCrawlDomainStateRepo(db, ownStatement),
				pages: createPageRepo(db, ownStatement),
				search: createSearchRepo(db),
			},
			close(): void {
				if (closed) return;
				for (const statement of ownedStatements) statement.finalize();
				db.close(true);
				closed = true;
			},
		};
	} catch (error) {
		for (const statement of ownedStatements) statement.finalize();
		db.close();
		throw error;
	}
}

export interface CrawlRunRow {
	id: string;
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
	total_data_bytes: number;
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
	const canonical = canonicalizeStorageDateTime(value);
	if (!canonical) {
		throw new Error(`Persisted timestamp is outside the date-time contract: ${value}`);
	}
	return canonical;
}

export function mapCrawlRunRow(row: CrawlRunRow): CrawlRunRecord {
	let options: unknown;
	try {
		options = JSON.parse(row.options_json);
	} catch (error) {
		throw new Error(`Crawl run ${row.id} contains invalid options JSON`, {
			cause: error,
		});
	}
	if (!isCrawlOptions(options)) {
		throw new Error(`Crawl run ${row.id} contains options outside the current contract`);
	}
	const counters = {
		pagesScanned: row.pages_scanned,
		successCount: row.success_count,
		failureCount: row.failure_count,
		skippedCount: row.skipped_count,
		linksFound: row.links_found,
		mediaFiles: row.media_files,
		totalDataKb: bytesToKilobytes(row.total_data_bytes),
	};
	if (!isCrawlCounters(counters)) {
		throw new Error(`Crawl run ${row.id} contains invalid counters`);
	}
	if (!Number.isSafeInteger(row.event_sequence) || row.event_sequence < 0) {
		throw new Error(`Crawl run ${row.id} contains an invalid event sequence`);
	}

	return {
		id: row.id,
		target: options.target,
		status: row.status,
		options,
		stopReason: row.stop_reason,
		createdAt: toIsoDateTime(row.created_at) as string,
		startedAt: toIsoDateTime(row.started_at),
		updatedAt: toIsoDateTime(row.updated_at) as string,
		completedAt: toIsoDateTime(row.completed_at),
		counters,
		eventSequence: row.event_sequence,
		resumable: isResumableCrawlStatus(row.status),
	};
}

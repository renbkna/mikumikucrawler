import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
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

const migrationsDirectory = path.join(import.meta.dir, "migrations");

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
	mkdirSync(path.dirname(databasePath), { recursive: true });
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

interface MigrationLedgerRow {
	id: string;
	checksum: string;
}

const PRE_BASELINE_MIGRATION_LINEAGE: readonly MigrationLedgerRow[] = [
	{
		id: "0001_crawl_runs.sql",
		checksum: "1edde97ced24f365f39170e3a1c7aa4243c6de9206da76e20a43c6a3c5f0aa65",
	},
	{
		id: "0002_queue_pages.sql",
		checksum: "39ba2a8bed421955fe3440a7c941811b3455a24834022e73001b584e4cc4e4dd",
	},
	{
		id: "0003_pages_fts.sql",
		checksum: "c5ab6c1a66d02d4eb6b25bbf95ca65d3d3a3f0f8e8c52deda57e969107f9be7a",
	},
	{
		id: "0004_runtime_persistence.sql",
		checksum: "1ee0367d3d7e2d509b854f865f57de227552f773ff65e05d3253c7d44921a125",
	},
	{
		id: "0005_domain_state_search_content.sql",
		checksum: "4db5499beebd32a2ef89b3d320b641e08096b9a14cab074bdbb13d9f25b0ccf6",
	},
	{
		id: "0006_canonical_schema.sql",
		checksum: "1799d36e1cd490d5c66c6e6a9a5b70366f1fdfeacb7f9ec43018c82b672f0fd4",
	},
	{
		id: "0007_terminal_queue_exclusion.sql",
		checksum: "6bdd9a79314b27d205d86b2132d8b1a5389f5856edffd02a4acb00797f79a4c5",
	},
	{
		id: "0008_storage_authority.sql",
		checksum: "26478c5cfc7daf4a30e8717be9b274dc5364b9a8421fe2856c9a733b4310ac21",
	},
	{
		id: "0009_redirect_domain_authority.sql",
		checksum: "d76d2a85f3d608f8274b55656048390cfa5edf70d28337b07ce34dca8f8688dd",
	},
	{
		id: "0010_compact_projections.sql",
		checksum: "c738d8793d4c80fd78c79888cbcdb54750444df7b212ad6766521cea6b089920",
	},
];

function normalizeSchemaSql(sql: string | null): string {
	return (sql ?? "")
		.replaceAll('"', "")
		.replace(/\s+/g, " ")
		.replace(/\s*([(),])\s*/g, "$1")
		.trim();
}

function matchesCanonicalSchema(db: Database, canonicalSql: string): boolean {
	const canonical = new Database(":memory:");
	try {
		canonical.exec(canonicalSql);
		const canonicalObjects = canonical
			.query(
				"SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
			)
			.all() as Array<{ type: string; name: string; sql: string | null }>;

		for (const expected of canonicalObjects) {
			const actual = db
				.query("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
				.get(expected.type, expected.name) as { sql: string | null } | null;
			if (actual === null || normalizeSchemaSql(actual.sql) !== normalizeSchemaSql(expected.sql)) {
				return false;
			}
		}

		return db.query("PRAGMA foreign_key_check").all().length === 0;
	} finally {
		canonical.close();
	}
}

function adoptCanonicalBaseline(
	db: Database,
	ledgerRows: MigrationLedgerRow[],
	migrationFiles: string[],
	migrationDirectory: string,
): MigrationLedgerRow[] {
	if (
		migrationFiles.length !== 1 ||
		migrationFiles[0] !== "0001_schema.sql" ||
		ledgerRows.length !== PRE_BASELINE_MIGRATION_LINEAGE.length ||
		!ledgerRows.every(
			(row, index) =>
				row.id === PRE_BASELINE_MIGRATION_LINEAGE[index]?.id &&
				row.checksum === PRE_BASELINE_MIGRATION_LINEAGE[index]?.checksum,
		)
	) {
		return ledgerRows;
	}

	const baselineId = migrationFiles[0];
	const baselineSql = readFileSync(path.join(migrationDirectory, baselineId), "utf8");
	if (!matchesCanonicalSchema(db, baselineSql)) {
		throw new Error(
			"Applied pre-baseline migration lineage does not match the canonical schema; no migration was performed",
		);
	}

	const baseline = { id: baselineId, checksum: migrationChecksum(baselineSql) };
	db.exec("DELETE FROM schema_migrations");
	db.query("INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)").run(
		baseline.id,
		baseline.checksum,
	);
	return [baseline];
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

		const storedLedgerRows = db
			.query("SELECT id, checksum FROM schema_migrations ORDER BY id")
			.all() as MigrationLedgerRow[];
		const ledgerRows = adoptCanonicalBaseline(
			db,
			storedLedgerRows,
			migrationFiles,
			migrationDirectory,
		);
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

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
import { config } from "../config/env.js";
import {
	archiveLegacySchema,
	importArchivedLegacyData,
	prepareCanonicalMigrationColumns,
} from "./legacyMigration.js";
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

function migrationChecksum(sql: string): string {
	return createHash("sha256").update(sql).digest("hex");
}

const LEGACY_UNVERIFIED_CHECKSUM = "legacy-unverified";
const acceptedHistoricalChecksums: Readonly<Record<string, ReadonlySet<string>>> = {
	"0001_crawl_runs.sql": new Set([
		"8f3a188974f103571720f1976bec802baa5b218b6b4c71549914458d5b57ce65",
	]),
	"0002_queue_pages.sql": new Set([
		"d832a13bed5bc51ad65eab821e48d12674200147f7e16b5fbdbbaa2341a3b473",
	]),
	"0003_pages_fts.sql": new Set([
		"fc7cddafb8f76c8258bfeee2e4bca143de3f5712210f4eb83d5b4a507d76c7d6",
	]),
	"0004_runtime_persistence.sql": new Set([
		"af6fe768ee351c1581eebfdf7862210a4ed2c064cc5635e063b9ec3bde3e1cc6",
	]),
};

function isAcceptedAppliedChecksum(
	migrationId: string,
	appliedChecksum: string,
	currentChecksum: string,
): boolean {
	return (
		appliedChecksum === currentChecksum ||
		appliedChecksum === LEGACY_UNVERIFIED_CHECKSUM ||
		acceptedHistoricalChecksums[migrationId]?.has(appliedChecksum) === true
	);
}

export function applyMigrations(db: Database, migrationDirectory = migrationsDirectory): void {
	const migrationFiles = readdirSync(migrationDirectory)
		.filter((fileName) => fileName.endsWith(".sql"))
		.sort();
	const knownMigrationIds = new Set(migrationFiles);

	db.transaction(() => {
		const legacyArchive = archiveLegacySchema(db);
		db.exec(`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				id TEXT PRIMARY KEY,
				applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				checksum TEXT NOT NULL
			)
		`);

		const columns = db.query("PRAGMA table_info(schema_migrations)").all() as Array<{
			name: string;
		}>;
		if (!columns.some((column) => column.name === "checksum")) {
			db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
		}

		const ledgerRows = db
			.query("SELECT id, checksum FROM schema_migrations ORDER BY id")
			.all() as Array<{ id: string; checksum: string | null }>;
		const unknownAppliedMigration = ledgerRows.find((row) => !knownMigrationIds.has(row.id));
		if (unknownAppliedMigration !== undefined) {
			throw new Error(
				`Applied migration ${unknownAppliedMigration.id} is not present in this release lineage`,
			);
		}
		db.query("UPDATE schema_migrations SET checksum = ? WHERE checksum IS NULL").run(
			LEGACY_UNVERIFIED_CHECKSUM,
		);

		if (legacyArchive.archivedPages) {
			db.exec(`
				DELETE FROM schema_migrations
				WHERE id IN (
					'0002_queue_pages.sql',
					'0003_pages_fts.sql',
					'0005_domain_state_search_content.sql',
					'0006_canonical_schema.sql'
				)
			`);
		}

		const applied = new Map(
			(
				db.query("SELECT id, checksum FROM schema_migrations ORDER BY id").all() as Array<{
					id: string;
					checksum: string;
				}>
			).map((row) => [row.id, row.checksum] as const),
		);
		const insertMigration = db.prepare(
			"INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)",
		);

		for (const fileName of migrationFiles) {
			const sql = readFileSync(path.join(migrationDirectory, fileName), "utf8");
			const checksum = migrationChecksum(sql);
			const appliedChecksum = applied.get(fileName);
			if (appliedChecksum !== undefined) {
				if (!isAcceptedAppliedChecksum(fileName, appliedChecksum, checksum)) {
					throw new Error(
						`Applied migration ${fileName} checksum mismatch; database was migrated with different SQL`,
					);
				}
				continue;
			}

			if (fileName === "0006_canonical_schema.sql") {
				prepareCanonicalMigrationColumns(db);
			}
			db.exec(sql);
			insertMigration.run(fileName, checksum);
		}

		importArchivedLegacyData(db, legacyArchive);
	})();
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
			crawlItems: createCrawlItemPersistence(db),
			crawlDomainState: createCrawlDomainStateRepo(db),
			pages: createPageRepo(db),
			search: createSearchRepo(db),
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
	if (row.target !== options.target) {
		throw new Error(`Crawl run ${row.id} has conflicting target projections`);
	}

	const counters = {
		pagesScanned: row.pages_scanned,
		successCount: row.success_count,
		failureCount: row.failure_count,
		skippedCount: row.skipped_count,
		linksFound: row.links_found,
		mediaFiles: row.media_files,
		totalDataKb: row.total_data_kb,
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
		createdAt: toIsoDateTime(row.created_at) ?? row.created_at,
		startedAt: toIsoDateTime(row.started_at),
		updatedAt: toIsoDateTime(row.updated_at) ?? row.updated_at,
		completedAt: toIsoDateTime(row.completed_at),
		counters,
		eventSequence: row.event_sequence,
		resumable: isResumableCrawlStatus(row.status),
	};
}

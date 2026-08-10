import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
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

const schemaPath = path.join(import.meta.dir, "schema.sql");

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

interface SchemaObject {
	type: string;
	name: string;
	tableName: string;
	sql: string | null;
}

function normalizeSchemaSql(sql: string | null): string | null {
	return (
		sql
			?.replaceAll('"', "")
			.replace(/\s+/g, " ")
			.replace(/\s*([(),])\s*/g, "$1")
			.trim() ?? null
	);
}

function describeSchema(db: Database): SchemaObject[] {
	return (
		db
			.query(
				"SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
			)
			.all() as SchemaObject[]
	).map((object) => ({ ...object, sql: normalizeSchemaSql(object.sql) }));
}

function hasCurrentSchema(db: Database, schemaSql: string): boolean {
	const canonical = new Database(":memory:");
	try {
		canonical.exec(schemaSql);
		return (
			JSON.stringify(describeSchema(db)) === JSON.stringify(describeSchema(canonical)) &&
			db.query("PRAGMA foreign_key_check").all().length === 0
		);
	} finally {
		canonical.close();
	}
}

function openDatabase(databasePath: string): Database {
	const db = new Database(databasePath);
	try {
		configurePragmas(db, databasePath);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

function removeDatabaseFiles(databasePath: string): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		rmSync(`${databasePath}${suffix}`, { force: true });
	}
}

function createSchema(db: Database, schemaSql: string): void {
	db.transaction(() => db.exec(schemaSql))();
}

function openCurrentDatabase(databasePath: string): Database {
	const schemaSql = readFileSync(schemaPath, "utf8");
	let db = openDatabase(databasePath);
	try {
		if (describeSchema(db).length === 0) {
			createSchema(db, schemaSql);
			return db;
		}
		if (hasCurrentSchema(db, schemaSql)) return db;
	} catch (error) {
		db.close();
		throw error;
	}

	db.close(true);
	removeDatabaseFiles(databasePath);
	db = openDatabase(databasePath);
	try {
		createSchema(db, schemaSql);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

export function createStorage(
	databasePath = config.dbPath,
	options: CreateStorageOptions = {},
): Storage {
	ensureDatabaseDirectory(databasePath);
	const db = openCurrentDatabase(databasePath);
	const ownedStatements: Array<{ finalize(): void }> = [];
	const ownStatement: OwnStatement = (statement) => {
		ownedStatements.push(statement);
		return statement;
	};
	try {
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

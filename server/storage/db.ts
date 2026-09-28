import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config/env.js";
import { DurableStorageBudget } from "./DurableStorageBudget.js";
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
	repos: StorageRepos;
	budget: DurableStorageBudget;
	close(): void;
}

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

function createSchema(db: Database, schemaSql: string): void {
	db.transaction(() => db.exec(schemaSql))();
}

function resetSchema(db: Database, schemaSql: string): void {
	// Keep the exclusive connection and file identity throughout the reset.
	db.exec("PRAGMA foreign_keys = OFF");
	try {
		db.transaction(() => {
			for (const type of ["trigger", "view", "table"]) {
				// Re-read after each drop: virtual tables remove their own shadow tables.
				while (true) {
					const object = describeSchema(db).find((entry) => entry.type === type);
					if (!object) break;
					db.exec(`DROP ${type} "${object.name.replaceAll('"', '""')}"`);
				}
			}
			db.exec(schemaSql);
		})();
	} finally {
		db.exec("PRAGMA foreign_keys = ON");
	}
}

function openCurrentDatabase(databasePath: string): Database {
	const schemaSql = readFileSync(schemaPath, "utf8");
	const db = openDatabase(databasePath);
	try {
		if (describeSchema(db).length === 0) {
			createSchema(db, schemaSql);
			return db;
		}
		if (hasCurrentSchema(db, schemaSql)) return db;
		resetSchema(db, schemaSql);
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
	try {
		const crawlQueue = createCrawlQueueRepo(db);
		const pages = createPageRepo(db);
		let closed = false;
		return {
			budget: new DurableStorageBudget(db, {
				maxBytes: options.maxBytes ?? config.maxStorageBytes,
				...(options.pageReservationBytes === undefined
					? {}
					: { pageReservationBytes: options.pageReservationBytes }),
			}),
			repos: {
				crawlRuns: createCrawlRunRepo(db, crawlQueue),
				crawlQueue,
				crawlItems: createCrawlItemPersistence(db, pages),
				crawlDomainState: createCrawlDomainStateRepo(db),
				pages,
				search: createSearchRepo(db),
			},
			close(): void {
				if (closed) return;
				// close(true) finalizes every statement the repos prepared.
				db.close(true);
				closed = true;
			},
		};
	} catch (error) {
		db.close(true);
		throw error;
	}
}

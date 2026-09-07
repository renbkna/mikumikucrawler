import { Database } from "bun:sqlite";
import { spyOn } from "bun:test";
import type { CrawlOptions } from "../../shared/contracts/index.js";
import { type CreateStorageOptions, createStorage, type Storage } from "../storage/db.js";

// SQL fault injection and schema inspection belong to tests, not the application Storage API.
// Capture the platform connection during synchronous construction, then immediately restore SQLite.
const testDatabases = new WeakMap<Storage, Database>();

export function createStorageFixture(
	databasePath: string,
	options: CreateStorageOptions = {},
): Storage {
	let database: Database | undefined;
	const exec = Database.prototype.exec;
	using _capture = spyOn(Database.prototype, "exec").mockImplementation(function (
		this: Database,
		...args: Parameters<Database["exec"]>
	) {
		database ??= this;
		return exec.apply(this, args);
	});
	const storage = createStorage(databasePath, options);
	if (!database) {
		storage.close();
		throw new Error("Storage fixture did not observe SQLite initialization");
	}
	testDatabases.set(storage, database);
	return storage;
}

export function getTestDatabase(storage: Storage): Database {
	const database = testDatabases.get(storage);
	if (!database) throw new Error("Storage was not created by the SQL test fixture");
	return database;
}

export function createInMemoryStorage(options: CreateStorageOptions = {}): Storage {
	return createStorageFixture(":memory:", options);
}

export function createCrawlOptionsFixture(overrides: Partial<CrawlOptions> = {}): CrawlOptions {
	return {
		target: "https://example.com/",
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
		...overrides,
	};
}

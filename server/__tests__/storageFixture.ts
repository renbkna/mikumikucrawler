import type { CrawlOptions } from "../../shared/contracts/index.js";
import { type CreateStorageOptions, createStorage, type Storage } from "../storage/db.js";

export function createInMemoryStorage(options: CreateStorageOptions = {}): Storage {
	return createStorage(":memory:", options);
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

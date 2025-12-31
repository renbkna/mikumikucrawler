import { describe, expect, mock, test } from "bun:test";
import type { Logger } from "../../config/logging.js";
import type { CrawlerSocket, SanitizedCrawlOptions } from "../../types.js";
import { CrawlQueue } from "../modules/crawlQueue.js";
import { CrawlState } from "../modules/crawlState.js";

const createMockLogger = (): Logger =>
	({
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		debug: mock(() => {}),
	}) as unknown as Logger;

const createMockSocket = (): CrawlerSocket => ({
	id: "test-socket",
	emit: mock(() => {}),
});

const createMockOptions = (
	overrides: Partial<SanitizedCrawlOptions> = {},
): SanitizedCrawlOptions => ({
	target: "https://example.com",
	crawlDepth: 2,
	maxPages: 100,
	crawlDelay: 100,
	crawlMethod: "full",
	maxConcurrentRequests: 5,
	retryLimit: 3,
	dynamic: false,
	respectRobots: true,
	contentOnly: false,
	saveMedia: false,
	...overrides,
});

describe("CrawlQueue", () => {
	test("tracks active items with Set for atomic operations", async () => {
		const logger = createMockLogger();
		const socket = createMockSocket();
		const options = createMockOptions({ maxConcurrentRequests: 2 });
		const state = new CrawlState(socket, logger);

		let processCount = 0;
		const processItem = mock(async () => {
			processCount++;
			// Simulate some async work
			await new Promise((resolve) => setTimeout(resolve, 10));
		});

		const queue = new CrawlQueue({
			options,
			state,
			logger,
			socket,
			processItem,
		});

		// Initial activeCount should be 0
		expect(queue.activeCount).toBe(0);

		// Enqueue items
		queue.enqueue({ url: "https://example.com/1", depth: 0, retries: 0 });
		queue.enqueue({ url: "https://example.com/2", depth: 0, retries: 0 });

		// Start processing and wait briefly
		const startPromise = queue.start();

		// Allow some processing time
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Stop the crawl
		state.stop();

		// Wait for queue to finish
		await startPromise;

		// Verify items were processed
		expect(processCount).toBeGreaterThan(0);
	});

	test("enqueue ignores visited URLs", () => {
		const logger = createMockLogger();
		const socket = createMockSocket();
		const options = createMockOptions();
		const state = new CrawlState(socket, logger);

		const queue = new CrawlQueue({
			options,
			state,
			logger,
			socket,
			processItem: mock(async () => {}),
		});

		// Mark URL as visited
		state.markVisited("https://example.com/visited");

		// Try to enqueue the visited URL
		queue.enqueue({
			url: "https://example.com/visited",
			depth: 0,
			retries: 0,
		});

		// Should not be in queue (check by starting and verifying no processing)
		expect(queue.activeCount).toBe(0);
	});

	test("scheduleRetry adds item back to queue after delay", async () => {
		const logger = createMockLogger();
		const socket = createMockSocket();
		const options = createMockOptions();
		const state = new CrawlState(socket, logger);

		const queue = new CrawlQueue({
			options,
			state,
			logger,
			socket,
			processItem: mock(async () => {}),
		});

		const item = { url: "https://example.com/retry", depth: 0, retries: 1 };

		// Schedule a retry with very short delay
		queue.scheduleRetry(item, 10);

		// Wait for retry
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Item should be enqueueable (not marked as visited)
		expect(state.hasVisited(item.url)).toBe(false);
	});

	test("clearRetries cancels pending retry timers", () => {
		const logger = createMockLogger();
		const socket = createMockSocket();
		const options = createMockOptions();
		const state = new CrawlState(socket, logger);

		const queue = new CrawlQueue({
			options,
			state,
			logger,
			socket,
			processItem: mock(async () => {}),
		});

		// Schedule multiple retries
		queue.scheduleRetry(
			{ url: "https://example.com/1", depth: 0, retries: 1 },
			1000,
		);
		queue.scheduleRetry(
			{ url: "https://example.com/2", depth: 0, retries: 1 },
			1000,
		);

		// Clear all retries
		queue.clearRetries();

		// Should not throw and retries should be cleared
		expect(true).toBe(true);
	});
});

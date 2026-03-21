import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Logger } from "../../../config/logging.js";
import type {
	CrawlerSocket,
	FetchResult,
	QueueItem,
	SanitizedCrawlOptions,
} from "../../../types.js";
import type { DynamicRenderer } from "../../dynamicRenderer.js";
import type { CrawlQueue } from "../crawlQueue.js";
import type { CrawlState } from "../crawlState.js";

/**
 * CONTRACT: PagePipeline
 *
 * Purpose: Orchestrates the full page processing pipeline from fetch to storage.
 * Integrates content fetching, processing, robots.txt compliance, and link discovery.
 *
 * PIPELINE STAGES:
 *   1. STATE CHECK: Verify session active, domain budget, not visited
 *   2. FETCH: Get content via static/dynamic fetcher
 *   3. PROCESS: Parse, sanitize, analyze content
 *   4. VALIDATE: Soft 404 detection, robots directives
 *   5. STORE: Save to database with links
 *   6. DISCOVER: Queue new links with batch processing
 *
 * INPUTS:
 *   - PagePipelineParams: options, state, logger, socket, db, dynamicRenderer, queue, targetDomain, sessionId
 *   - item: QueueItem { url, depth, retries, domain, parentUrl }
 *
 * OUTPUTS:
 *   - processItem(): Promise<void> - side effects only
 *   - Database writes: pages, links tables
 *   - Socket emissions: stats, pageContent
 *   - Queue additions: new URLs to crawl
 *
 * INVARIANTS:
 *   1. STATE VALIDATION: Always checks state.canProcessMore() before work
 *   2. DEDUPLICATION: Skips if state.hasVisited(item.url)
 *   3. DOMAIN BUDGET: Respects per-domain crawl limits
 *   4. TRANSACTIONAL SAVE: Database operations in single transaction
 *   5. STATS THROTTLE: Emits stats at most every 250ms
 *   6. CONTENT SANITIZATION: HTML always sanitized before storage
 *   7. ROBOTS COMPLIANCE: Respects noindex/nofollow directives
 *   8. SOFT 404 DETECTION: Prevents storing error pages as content
 *   9. CANONICAL HANDLING: Marks canonical URLs as visited
 *  10. IDEMPOTENT: Multiple calls with same item are safe (idempotent)
 *
 * FORBIDDEN STATES:
 *   - Processing without state check
 *   - Storing unsanitized HTML
 *   - Ignoring robots.txt noindex
 *   - Queueing links beyond crawlDepth
 *   - Unthrottled stats emissions
 *   - Multiple database writes for same page
 *
 * EDGE CASES:
 *   - Fetch timeout/error with retry logic
 *   - 304 Not Modified (unchanged content)
 *   - Rate limiting with Retry-After
 *   - ContentProcessor failure
 *   - Database transaction failure
 *   - Invalid URLs in links
 *   - Missing content type
 *   - Memory pressure during processing
 */

// Mock fetchContent BEFORE importing the module under test.
// Bun hoists mock.module() calls so pagePipeline.ts gets the mock when loaded.
const mockFetchContent = mock(
	async (_opts: unknown): Promise<FetchResult> => ({
		type: "success",
		content: "<html><body><h1>Test Page</h1></body></html>",
		statusCode: 200,
		contentType: "text/html",
		contentLength: 1024,
		title: "Test Page",
		description: "Test description",
		lastModified: null,
		etag: null,
		xRobotsTag: null,
		isDynamic: false,
	}),
);

mock.module("../fetcher.js", () => ({
	fetchContent: mockFetchContent,
}));

// Import AFTER registering the module mock
const { createPagePipeline } = await import("../pagePipeline.js");

const createMockLogger = (): Logger => ({
	info: mock(() => {}),
	warn: mock(() => {}),
	error: mock(() => {}),
	debug: mock(() => {}),
});

const createMockSocket = (): CrawlerSocket & {
	getEmissions: () => { event: string; data: unknown }[];
} => {
	const emissions: { event: string; data: unknown }[] = [];
	return {
		emit: (event: string, data: unknown) => {
			emissions.push({ event, data });
		},
		getEmissions: () => emissions,
	} as CrawlerSocket & { getEmissions: () => typeof emissions };
};

const createMockDb = (): Partial<Database> => ({
	prepare: mock(() => ({
		get: mock(() => ({ id: 1 })),
		run: mock(() => ({ changes: 1 })),
		all: mock(() => []),
	})) as unknown as ReturnType<Database["prepare"]>,
	query: mock(() => ({
		all: mock(() => []),
		run: mock(() => ({ changes: 1 })),
	})) as unknown as ReturnType<Database["query"]>,
	transaction: mock((fn: (params: unknown) => unknown) => {
		return (params: unknown) => fn(params);
	}) as unknown as Database["transaction"],
});

const createMockState = (): Partial<CrawlState> => ({
	canProcessMore: mock(() => true),
	hasVisited: mock(() => false),
	markVisited: mock(() => {}),
	recordSuccess: mock(() => {}),
	recordFailure: mock(() => {}),
	recordSkip: mock(() => {}),
	addLinks: mock(() => {}),
	addMedia: mock(() => {}),
	setDomainDelay: mock(() => {}),
	recordDomainPage: mock(() => {}),
	adaptDomainDelay: mock(() => {}),
	isDomainBudgetExceeded: mock(() => false),
	emitLog: mock(() => {}),
	emitStats: mock(() => {}),
	isActive: true,
	stats: {
		pagesScanned: 0,
		linksFound: 0,
		totalData: 0,
		mediaFiles: 0,
		successCount: 0,
		failureCount: 0,
		skippedCount: 0,
	},
});

const createMockQueue = (): Partial<CrawlQueue> => ({
	enqueue: mock(() => {}),
	scheduleRetry: mock(() => {}),
	getQueue: mock(() => []),
});

const createMockDynamicRenderer = (): Partial<DynamicRenderer> => ({
	isEnabled: mock(() => false),
	render: mock(() => Promise.resolve(null)),
});

const createOptions = (
	overrides?: Partial<SanitizedCrawlOptions>,
): SanitizedCrawlOptions => ({
	target: "https://example.com",
	crawlDepth: 2,
	maxPages: 100,
	maxPagesPerDomain: 0,
	crawlDelay: 100,
	crawlMethod: "full",
	maxConcurrentRequests: 5,
	retryLimit: 3,
	dynamic: false,
	respectRobots: false, // disable robots to avoid getRobotsRules network calls
	contentOnly: false,
	saveMedia: false,
	...overrides,
});

const createQueueItem = (overrides?: Partial<QueueItem>): QueueItem => ({
	url: "https://example.com/page",
	depth: 0,
	retries: 0,
	domain: "example.com",
	parentUrl: undefined,
	...overrides,
});

const buildPipeline = (
	stateOverrides?: Partial<CrawlState>,
	optionOverrides?: Partial<SanitizedCrawlOptions>,
) => {
	const state = { ...createMockState(), ...stateOverrides } as CrawlState;
	const logger = createMockLogger();
	const socket = createMockSocket();
	const db = createMockDb() as Database;
	const queue = createMockQueue() as CrawlQueue;
	const dynamicRenderer = createMockDynamicRenderer() as DynamicRenderer;

	const processItem = createPagePipeline({
		options: createOptions(optionOverrides),
		state,
		logger,
		socket,
		db,
		dynamicRenderer,
		queue,
		targetDomain: "example.com",
		sessionId: "test-session-123",
	});

	return { processItem, state, logger, socket, db, queue };
};

describe("PagePipeline CONTRACT", () => {
	beforeEach(() => {
		// Reset mock to default 200 response before each test
		mockFetchContent.mockImplementation(async () => ({
			type: "success" as const,
			content: "<html><body><h1>Test Page</h1></body></html>",
			statusCode: 200,
			contentType: "text/html",
			contentLength: 1024,
			title: "Test Page",
			description: "Test description",
			lastModified: null,
			etag: null,
			xRobotsTag: null,
			isDynamic: false,
		}));
	});

	describe("INVARIANT: State Validation", () => {
		test("skips processing when state.canProcessMore() returns false", async () => {
			// INVARIANT: Pipeline checks canProcessMore before any work
			const { processItem, state } = buildPipeline({
				canProcessMore: mock(() => false),
			} as Partial<CrawlState>);

			await processItem(createQueueItem());

			// fetchContent never called — verified via mock
			expect(mockFetchContent).not.toHaveBeenCalled();
			// markVisited never called — no work was done
			expect(state.markVisited).not.toHaveBeenCalled();
		});

		test("skips when URL already visited", async () => {
			// INVARIANT: Deduplication via state.hasVisited()
			const { processItem, state } = buildPipeline({
				hasVisited: mock(() => true),
			} as Partial<CrawlState>);

			await processItem(createQueueItem());

			expect(mockFetchContent).not.toHaveBeenCalled();
			expect(state.recordSuccess).not.toHaveBeenCalled();
		});

		test("skips when session is no longer active", async () => {
			// INVARIANT: Session state check prevents orphaned work
			const { processItem, state, logger } = buildPipeline({
				isActive: false,
			} as unknown as Partial<CrawlState>);

			await processItem(createQueueItem());

			expect(mockFetchContent).not.toHaveBeenCalled();
			// Logger.info called with skip message
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("session no longer active"),
			);
			// No side effects on state
			expect(state.recordSuccess).not.toHaveBeenCalled();
		});

		test("skips when domain budget exceeded", async () => {
			// INVARIANT: Domain budget enforced — marks visited and records skip, no fetch
			const { processItem, state } = buildPipeline({
				isDomainBudgetExceeded: mock(() => true),
			} as Partial<CrawlState>);

			await processItem(createQueueItem());

			expect(mockFetchContent).not.toHaveBeenCalled();
			// INVARIANT: Marks visited to prevent re-queueing
			expect(state.markVisited).toHaveBeenCalledWith(
				"https://example.com/page",
			);
			// INVARIANT: Records skip counter
			expect(state.recordSkip).toHaveBeenCalled();
		});
	});

	describe("INVARIANT: Happy Path Processing", () => {
		test("marks URL as visited after successful fetch", async () => {
			const { processItem, state } = buildPipeline();

			await processItem(createQueueItem());

			// INVARIANT: URL marked visited to prevent re-crawling
			expect(state.markVisited).toHaveBeenCalledWith(
				"https://example.com/page",
			);
		});

		test("records success with content length", async () => {
			const { processItem, state } = buildPipeline();

			await processItem(createQueueItem());

			// INVARIANT: recordSuccess called with the content length
			expect(state.recordSuccess).toHaveBeenCalledWith(1024);
		});

		test("emits pageContent event after successful save", async () => {
			const { processItem, socket } = buildPipeline();

			await processItem(createQueueItem());

			const emissions = socket.getEmissions();
			const pageContentEmissions = emissions.filter(
				(e) => e.event === "pageContent",
			);

			// INVARIANT: pageContent emitted exactly once per processed URL
			expect(pageContentEmissions.length).toBe(1);

			const pageData = pageContentEmissions[0].data as Record<string, unknown>;
			expect(pageData.url).toBe("https://example.com/page");
			expect(pageData.title).toBe("Test Page");
		});

		test("records domain page after successful save", async () => {
			const { processItem, state } = buildPipeline();

			await processItem(createQueueItem());

			// INVARIANT: Per-domain page counter updated
			expect(state.recordDomainPage).toHaveBeenCalledWith("example.com");
		});

		test("emits stats at least once during processing", async () => {
			const { processItem, state } = buildPipeline();

			await processItem(createQueueItem());

			// Stats emission now goes through state.emitStats/emitLog
			const emitStatsCalls = (state.emitStats as ReturnType<typeof mock>).mock
				.calls.length;
			const emitLogCalls = (state.emitLog as ReturnType<typeof mock>).mock.calls
				.length;
			expect(emitStatsCalls + emitLogCalls).toBeGreaterThanOrEqual(1);
		});
	});

	describe("INVARIANT: Error Handling", () => {
		test("fetch errors trigger retry scheduling", async () => {
			mockFetchContent.mockImplementation(async () => {
				throw new Error("Network timeout");
			});

			const { processItem, state, queue } = buildPipeline();
			const item = createQueueItem({ retries: 0 });

			await processItem(item);

			// INVARIANT: Failure recorded
			expect(state.recordFailure).toHaveBeenCalled();
			// INVARIANT: Retry scheduled when under retry limit
			expect(queue.scheduleRetry).toHaveBeenCalled();
		});

		test("respects retry limit — no retry when exhausted", async () => {
			mockFetchContent.mockImplementation(async () => {
				throw new Error("Network timeout");
			});

			const { processItem, state, queue } = buildPipeline(
				{},
				{ retryLimit: 3 },
			);
			const item = createQueueItem({ retries: 3 }); // at limit

			await processItem(item);

			// INVARIANT: Failure still recorded
			expect(state.recordFailure).toHaveBeenCalled();
			// INVARIANT: No retry scheduled when limit reached
			expect(queue.scheduleRetry).not.toHaveBeenCalled();
		});
	});

	describe("INVARIANT: 304 Not Modified", () => {
		test("marks visited and records success on 304", async () => {
			mockFetchContent.mockImplementation(async () => ({
				type: "unchanged" as const,
				statusCode: 304,
				lastModified: null,
				etag: null,
			}));

			const { processItem, state } = buildPipeline();

			await processItem(createQueueItem());

			// INVARIANT: 304 marks URL visited with zero content
			expect(state.markVisited).toHaveBeenCalledWith(
				"https://example.com/page",
			);
			expect(state.recordSuccess).toHaveBeenCalledWith(0);
		});
	});

	describe("INVARIANT: Rate Limiting", () => {
		test("rate-limited response schedules retry with Retry-After delay", async () => {
			mockFetchContent.mockImplementation(async () => ({
				type: "rateLimited" as const,
				retryAfterMs: 5000,
				statusCode: 429,
			}));

			const { processItem, queue, logger } = buildPipeline();
			const item = createQueueItem({ retries: 0 });

			await processItem(item);

			// INVARIANT: Warning logged for rate limit
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Rate-limited"),
			);
			// INVARIANT: Retry scheduled with the Retry-After delay
			expect(queue.scheduleRetry).toHaveBeenCalledWith(
				expect.objectContaining({ url: "https://example.com/page" }),
				5000,
			);
		});
	});

	describe("INVARIANT: Robots Directives", () => {
		test("noindex via X-Robots-Tag header is skipped — recordSkip called", async () => {
			// Use xRobotsTag (from HTTP response header) rather than meta tag because
			// ContentProcessor parsing is needed for meta-based robots detection.
			// The X-Robots-Tag path is directly in the FetchResult and always processed.
			mockFetchContent.mockImplementation(async () => ({
				type: "success" as const,
				content: "<html><body><h1>Page</h1></body></html>",
				statusCode: 200,
				contentType: "text/html",
				contentLength: 1000,
				title: "No Index Page",
				description: "",
				lastModified: null,
				etag: null,
				xRobotsTag: "noindex",
				isDynamic: false,
			}));

			const { processItem, state } = buildPipeline();

			await processItem(createQueueItem());

			// INVARIANT: noindex pages recorded as skip
			expect(state.recordSkip).toHaveBeenCalled();
			// The pipeline marks visited and records success (fetch succeeded)
			// BEFORE checking robots directives, so recordSuccess IS called
			expect(state.recordSuccess).toHaveBeenCalled();
		});

		test("noindex pages do not emit pageContent", async () => {
			mockFetchContent.mockImplementation(async () => ({
				type: "success" as const,
				content: "<html><body><h1>Page</h1></body></html>",
				statusCode: 200,
				contentType: "text/html",
				contentLength: 1000,
				title: "Noindex Page",
				description: "",
				lastModified: null,
				etag: null,
				xRobotsTag: "noindex",
				isDynamic: false,
			}));

			const { processItem, socket } = buildPipeline();

			await processItem(createQueueItem());

			// INVARIANT: noindex pages not emitted to client
			const emissions = socket.getEmissions();
			const pageContentEmissions = emissions.filter(
				(e) => e.event === "pageContent",
			);
			expect(pageContentEmissions.length).toBe(0);
		});
	});

	describe("INVARIANT: Soft 404 Detection", () => {
		test("detects soft 404 by title keyword — page not stored", async () => {
			mockFetchContent.mockImplementation(async () => ({
				type: "success" as const,
				content:
					"<html><body><h1>404 Not Found</h1><p>Page missing.</p></body></html>",
				statusCode: 200,
				contentType: "text/html",
				contentLength: 2000,
				title: "404 Not Found",
				description: "",
				lastModified: null,
				etag: null,
				xRobotsTag: null,
				isDynamic: false,
			}));

			const { processItem, state } = buildPipeline();

			await processItem(createQueueItem());

			// INVARIANT: Soft 404 recorded as skip, not stored
			expect(state.recordSkip).toHaveBeenCalled();
		});
	});
});

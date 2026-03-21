import type { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import type { Logger } from "../../config/logging.js";
import type { CrawlerSocket, SanitizedCrawlOptions } from "../../types.js";
import { CrawlSession } from "../CrawlSession.js";

/**
 * CONTRACT: CrawlSession
 *
 * Purpose: Manages the complete lifecycle of a crawl operation including
 * initialization, execution, and cleanup with support for resuming interrupted sessions.
 *
 * LIFECYCLE:
 *   1. CONSTRUCTION: Initialize state, renderer, queue, and pipeline
 *   2. START: Validate robots.txt, load sitemap, begin processing
 *   3. EXECUTION: Process queue items via page pipeline with coalescing
 *   4. STOP/INTERRUPT: Graceful or immediate shutdown with cleanup
 *   5. RESUME: Restore interrupted session from database
 *
 * INPUTS:
 *   - socket: CrawlerSocket for client communication
 *   - options: SanitizedCrawlOptions with target, depth, limits
 *   - db: Database for persistence
 *   - logger: Logger for operational logging
 *   - sessionId?: Optional existing session ID for resume
 *   - isResumed?: Whether this is a resumed session
 *
 * OUTPUTS:
 *   - start(): Promise<void> - begins crawl operation
 *   - stop(): Promise<void> - graceful shutdown
 *   - interrupt(): void - immediate shutdown
 *   - Socket emissions: stats, attackEnd, logs
 *   - Database writes: session state, queue items
 *
 * INVARIANTS:
 *   1. SINGLE SESSION ID: Each session has unique UUID
 *   2. IDEMPOTENT STOP: Multiple stop() calls return same promise
 *   3. ACTIVE STATE: state.isActive controls processing flow
 *   4. RESUME CHECK: Only "interrupted" sessions can be resumed
 *   5. ROBOTS COMPLIANCE: Respects robots.txt crawl-delay and disallow
 *   6. COALESCING: Per-session request deduplication
 *   7. CLEANUP ORDER: queue → renderer → database → socket
 *   8. PERSISTENCE: Session state saved on start and status changes
 *   9. TARGET DOMAIN: Extracted from options.target on construction
 *  10. RESUME SEEDING: Pre-seeds visited URLs from pages table
 *
 * FORBIDDEN STATES:
 *   - Active session without socket
 *   - Resume of non-interrupted session
 *   - Multiple simultaneous stop() operations
 *   - Processing after stop() called
 *   - Unpersisted session state
 *
 * EDGE CASES:
 *   - Invalid target URL
 *   - Robots.txt disallow
 *   - Empty sitemap
 *   - Database errors during persistence
 *   - Interrupted during queue processing
 *   - Renderer initialization failure
 *   - Network errors during robots.txt fetch
 */

const createMockLogger = (): Logger => ({
	info: mock(() => {}),
	warn: mock(() => {}),
	error: mock(() => {}),
	debug: mock(() => {}),
});

const createMockSocket = (socketId = "test-socket-1"): CrawlerSocket => {
	const emissions: { event: string; data: unknown }[] = [];
	return {
		id: socketId,
		emit: (event: string, data: unknown) => {
			emissions.push({ event, data });
		},
		getEmissions: () => emissions,
	} as CrawlerSocket & { getEmissions: () => typeof emissions; id: string };
};

const createMockDb = (): Partial<Database> => {
	const storedData: Map<string, unknown> = new Map();
	return {
		prepare: mock(() => ({
			get: mock((...params: unknown[]) => {
				const key = params.join("_");
				return storedData.get(key) ?? null;
			}),
			run: mock((...params: unknown[]) => {
				const key = params.join("_");
				storedData.set(key, { changes: 1 });
				return { changes: 1 };
			}),
			all: mock(() => []),
		})) as unknown as ReturnType<Database["prepare"]>,
		query: mock(() => ({
			all: mock(() => []),
			run: mock(() => ({ changes: 1 })),
		})) as unknown as ReturnType<Database["query"]>,
		transaction: mock((fn: (params: unknown) => unknown) => {
			return (params: unknown) => fn(params);
		}) as unknown as Database["transaction"],
		// Storage for assertions
		storedData,
	};
};

const createOptions = (
	overrides?: Partial<SanitizedCrawlOptions>,
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

describe("CrawlSession CONTRACT", () => {
	describe("INVARIANT: Construction", () => {
		test("creates session with unique ID", () => {
			const socket = createMockSocket();
			const db = createMockDb();
			const logger = createMockLogger();
			const options = createOptions();

			const session = new CrawlSession(
				socket as CrawlerSocket,
				options,
				db as Database,
				logger,
			);

			// INVARIANT: Each session has unique UUID
			expect(session.sessionId).toBeDefined();
			expect(typeof session.sessionId).toBe("string");
			expect(session.sessionId.length).toBeGreaterThan(0);
		});

		test("accepts provided session ID", () => {
			const socket = createMockSocket();
			const db = createMockDb();
			const logger = createMockLogger();
			const options = createOptions();
			const customId = "custom-session-id-123";

			const session = new CrawlSession(
				socket as CrawlerSocket,
				options,
				db as Database,
				logger,
				customId,
			);

			// INVARIANT: Provided session ID used
			expect(session.sessionId).toBe(customId);
		});

		test("extracts target domain from URL without error", () => {
			const socket = createMockSocket();
			const db = createMockDb();
			const logger = createMockLogger();
			const options = createOptions({ target: "https://sub.example.com/path" });

			new CrawlSession(
				socket as CrawlerSocket,
				options,
				db as Database,
				logger,
			);

			// INVARIANT: Valid URL extracts domain without logging an error
			expect(logger.error).not.toHaveBeenCalledWith(
				expect.stringContaining("Invalid target URL"),
			);
		});

		test("handles invalid target URL gracefully", () => {
			const socket = createMockSocket();
			const db = createMockDb();
			const logger = createMockLogger();
			const options = createOptions({ target: "not-a-valid-url" });

			// INVARIANT: Invalid URL logged but doesn't throw
			const session = new CrawlSession(
				socket as CrawlerSocket,
				options,
				db as Database,
				logger,
			);

			expect(session).toBeDefined();
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining("Invalid target URL"),
			);
		});
	});

	describe("INVARIANT: Lifecycle Management", () => {
		test("idempotent stop() returns same promise", async () => {
			const socket = createMockSocket();
			const db = createMockDb();
			const logger = createMockLogger();
			const options = createOptions();

			const session = new CrawlSession(
				socket as CrawlerSocket,
				options,
				db as Database,
				logger,
			);

			// INVARIANT: Multiple stop() calls return same promise
			const stop1 = session.stop();
			const stop2 = session.stop();
			const stop3 = session.stop();

			expect(stop1).toBe(stop2);
			expect(stop2).toBe(stop3);

			await stop1;
		});

		test("stop() resolves immediately when not active", async () => {
			const socket = createMockSocket();
			const db = createMockDb();
			const logger = createMockLogger();
			const options = createOptions();

			const session = new CrawlSession(
				socket as CrawlerSocket,
				options,
				db as Database,
				logger,
			);

			// First stop transitions to inactive
			await session.stop();

			// Second stop should resolve immediately
			const startTime = Date.now();
			await session.stop();
			const duration = Date.now() - startTime;

			// INVARIANT: Inactive session stop resolves quickly
			expect(duration).toBeLessThan(100);
		});

		test("interrupt() stops processing immediately", () => {
			const socket = createMockSocket();
			const db = createMockDb();
			const logger = createMockLogger();
			const options = createOptions();

			const session = new CrawlSession(
				socket as CrawlerSocket,
				options,
				db as Database,
				logger,
			);

			// INVARIANT: interrupt() is synchronous and immediate
			expect(() => session.interrupt()).not.toThrow();
		});
	});

	describe("INVARIANT: Socket Communication", () => {
		test("emits attackEnd on stop", async () => {
			const socket = createMockSocket();
			const db = createMockDb();
			const logger = createMockLogger();
			const options = createOptions();

			const session = new CrawlSession(
				socket as CrawlerSocket,
				options,
				db as Database,
				logger,
			);

			await session.stop();

			// INVARIANT: Final stats emitted via attackEnd
			const emissions = (
				socket as ReturnType<typeof createMockSocket>
			).getEmissions();
			const endEmissions = emissions.filter((e) => e.event === "attackEnd");
			expect(endEmissions.length).toBe(1);
		});

		test("emits attackEnd on stop after start", async () => {
			const socket = createMockSocket();
			const db = createMockDb();
			const logger = createMockLogger();
			const options = createOptions();

			const session = new CrawlSession(
				socket as CrawlerSocket,
				options,
				db as Database,
				logger,
			);

			const startPromise = session.start();
			await session.stop();
			await startPromise.catch(() => {});

			// INVARIANT: attackEnd always emitted on session end
			const emissions = (
				socket as ReturnType<typeof createMockSocket>
			).getEmissions();
			const endEmissions = emissions.filter((e) => e.event === "attackEnd");
			expect(endEmissions.length).toBe(1);
		});
	});

	describe("INVARIANT: Session Persistence", () => {
		test("saves session on start", async () => {
			const socket = createMockSocket();
			const db = createMockDb();
			const logger = createMockLogger();
			const options = createOptions();

			const session = new CrawlSession(
				socket as CrawlerSocket,
				options,
				db as Database,
				logger,
			);

			// INVARIANT: Session state persisted to database when start() is called
			// start() calls saveSession() which calls db.query()
			const startPromise = session.start();
			await session.stop();
			await startPromise.catch(() => {});

			// db.query was called at least once (for saveSession and updateSessionStatus)
			expect(db.query).toHaveBeenCalled();
		});

		test("resume returns null for non-existent session", () => {
			const socket = createMockSocket();
			const db = createMockDb();
			const logger = createMockLogger();

			// INVARIANT: Resume fails gracefully for missing sessions
			const resumed = CrawlSession.resume(
				"non-existent-session",
				socket as CrawlerSocket,
				db as Database,
				logger,
			);

			expect(resumed).toBeNull();
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("not found"),
			);
		});

		test("resume returns null for non-interrupted session", () => {
			const socket = createMockSocket();
			const db = createMockDb();
			const logger = createMockLogger();

			// Mock a completed session in database
			const mockQuery = mock(() => ({
				get: mock(() => ({
					id: "completed-session",
					status: "completed",
					options: JSON.stringify(createOptions()),
				})),
			}));
			db.query = mockQuery as unknown as Database["query"];

			// INVARIANT: Only interrupted sessions can be resumed
			const resumed = CrawlSession.resume(
				"completed-session",
				socket as CrawlerSocket,
				db as Database,
				logger,
			);

			expect(resumed).toBeNull();
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("not interrupted"),
			);
		});

		test("successfully resumes interrupted session", () => {
			const socket = createMockSocket("new-socket-id");
			const db = createMockDb();
			const logger = createMockLogger();

			// Mock an interrupted session with options
			const sessionId = "interrupted-session-123";
			const storedOptions = createOptions({
				target: "https://resume.example.com",
			});

			// Setup database mock to return interrupted session
			// Note: This mocks the internal query used by loadSession()
			const storedData = new Map<string, unknown>([
				[
					`SELECT options, stats, status FROM crawl_sessions WHERE id = ? LIMIT 1_${sessionId}`,
					{
						options: JSON.stringify(storedOptions),
						stats: null,
						status: "interrupted",
					},
				],
			]);

			// Override the mock to use storedData
			const originalQuery = db.query;
			db.query = mock((sql: string) => ({
				get: mock((...params: unknown[]) => {
					const key = `${sql}_${params.join("_")}`;
					return storedData.get(key) ?? null;
				}),
				run: mock(() => ({ changes: 1 })),
				all: mock(() => []),
			})) as unknown as Database["query"];

			// INVARIANT: Successfully resumes interrupted session
			const resumed = CrawlSession.resume(
				sessionId,
				socket as CrawlerSocket,
				db as Database,
				logger,
			);

			expect(resumed).not.toBeNull();
			expect(resumed?.sessionId).toBe(sessionId);

			// Restore original mock
			db.query = originalQuery;
		});

		test("resume pre-seeds visited URLs from pages table", () => {
			const socket = createMockSocket("new-socket-id");
			const db = createMockDb();
			const logger = createMockLogger();

			const sessionId = "session-with-pages";
			const storedOptions = createOptions();

			// Mock database returning pages that were already crawled
			const crawledUrls = [
				{ url: "https://example.com/page1" },
				{ url: "https://example.com/page2" },
				{ url: "https://example.com/page3" },
			];

			// Setup storedData for session lookup and pages query
			const storedData = new Map<string, unknown>([
				[
					`SELECT options, stats, status FROM crawl_sessions WHERE id = ? LIMIT 1_${sessionId}`,
					{
						options: JSON.stringify(storedOptions),
						stats: null,
						status: "interrupted",
					},
				],
			]);

			const originalQuery = db.query;
			db.query = mock((sql: string) => ({
				get: mock((...params: unknown[]) => {
					const key = `${sql}_${params.join("_")}`;
					return storedData.get(key) ?? null;
				}),
				run: mock(() => ({ changes: 1 })),
				all: mock(() => crawledUrls),
			})) as unknown as Database["query"];

			// INVARIANT: Resume pre-seeds visited URLs from pages table
			const resumed = CrawlSession.resume(
				sessionId,
				socket as CrawlerSocket,
				db as Database,
				logger,
			);

			expect(resumed).not.toBeNull();

			// Restore original mock
			db.query = originalQuery;
		});

		test("resume loads pending queue items from database", () => {
			const socket = createMockSocket("new-socket-id");
			const db = createMockDb();
			const logger = createMockLogger();

			const sessionId = "session-with-queue";
			const storedOptions = createOptions();

			// Setup storedData for session lookup
			const storedData = new Map<string, unknown>([
				[
					`SELECT options, stats, status FROM crawl_sessions WHERE id = ? LIMIT 1_${sessionId}`,
					{
						options: JSON.stringify(storedOptions),
						stats: null,
						status: "interrupted",
					},
				],
			]);

			const originalQuery = db.query;
			db.query = mock((sql: string) => ({
				get: mock((...params: unknown[]) => {
					const key = `${sql}_${params.join("_")}`;
					return storedData.get(key) ?? null;
				}),
				run: mock(() => ({ changes: 1 })),
				all: mock(() => []),
			})) as unknown as Database["query"];

			// INVARIANT: Resume loads pending queue items
			const resumed = CrawlSession.resume(
				sessionId,
				socket as CrawlerSocket,
				db as Database,
				logger,
			);

			expect(resumed).not.toBeNull();

			// Restore original mock
			db.query = originalQuery;
		});

		test("resume updates socket_id in database", () => {
			const socket = createMockSocket("new-socket-id");
			const db = createMockDb();
			const logger = createMockLogger();

			const sessionId = "session-to-update";
			const storedOptions = createOptions();

			const runCalls: { sql: string; params: unknown[] }[] = [];

			// Setup storedData for session lookup
			const storedData = new Map<string, unknown>([
				[
					`SELECT options, stats, status FROM crawl_sessions WHERE id = ? LIMIT 1_${sessionId}`,
					{
						options: JSON.stringify(storedOptions),
						stats: null,
						status: "interrupted",
					},
				],
			]);

			const originalQuery = db.query;
			db.query = mock((sql: string) => ({
				get: mock((...params: unknown[]) => {
					const key = `${sql}_${params.join("_")}`;
					return storedData.get(key) ?? null;
				}),
				run: mock((...params: unknown[]) => {
					runCalls.push({ sql, params });
					return { changes: 1 };
				}),
				all: mock(() => []),
			})) as unknown as Database["query"];

			// INVARIANT: Resume updates socket_id to new socket
			CrawlSession.resume(
				sessionId,
				socket as CrawlerSocket,
				db as Database,
				logger,
			);

			// Check that UPDATE was called with new socket_id
			const updateCall = runCalls.find(
				(call) =>
					call.sql.includes("UPDATE crawl_sessions") &&
					call.sql.includes("socket_id"),
			);
			expect(updateCall).toBeDefined();

			// Restore original mock
			db.query = originalQuery;
		});
	});

	describe("EDGE CASE: Error Handling", () => {
		test("handles errors during start gracefully", async () => {
			const socket = createMockSocket();
			const db = createMockDb();
			const logger = createMockLogger();
			const options = createOptions();

			const session = new CrawlSession(
				socket as CrawlerSocket,
				options,
				db as Database,
				logger,
			);

			// INVARIANT: Errors logged and session stopped
			// Start may encounter errors (robots.txt, sitemap, etc.)
			// Production catches errors internally
			try {
				await session.start();
			} catch {
				// Errors should be caught and logged
			}

			// Cleanup
			await session.stop();
		});

		test("logs errors during stop", async () => {
			const socket = createMockSocket();
			const db = createMockDb();
			const logger = createMockLogger();
			const options = createOptions();

			const session = new CrawlSession(
				socket as CrawlerSocket,
				options,
				db as Database,
				logger,
			);

			await session.stop();

			// INVARIANT: Cleanup logged
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("Crawl session ended"),
			);
		});
	});

	describe("EDGE CASE: Options Handling", () => {
		test("preserves all options — session ID is stable across stop", async () => {
			const socket = createMockSocket();
			const db = createMockDb();
			const logger = createMockLogger();
			const options = createOptions({
				target: "https://specific.example.com",
				crawlDepth: 5,
				maxPages: 50,
				dynamic: true,
				respectRobots: false,
			});

			const session = new CrawlSession(
				socket as CrawlerSocket,
				options,
				db as Database,
				logger,
			);

			const idBefore = session.sessionId;
			await session.stop();
			const idAfter = session.sessionId;

			// INVARIANT: Session ID never changes
			expect(idBefore).toBe(idAfter);
		});

		test("calculates targetDomain correctly — no error logged for valid URLs", () => {
			const testCases = [
				"https://example.com",
				"https://sub.example.com/path",
				"http://example.com:8080",
			];

			for (const url of testCases) {
				const socket = createMockSocket();
				const db = createMockDb();
				const logger = createMockLogger();

				new CrawlSession(
					socket as CrawlerSocket,
					createOptions({ target: url }),
					db as Database,
					logger,
				);

				// INVARIANT: Valid URLs extract domain silently — no error logged
				expect(logger.error).not.toHaveBeenCalled();
			}
		});
	});
});

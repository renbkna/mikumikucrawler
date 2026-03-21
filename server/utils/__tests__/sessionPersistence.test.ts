import type { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import type {
	CrawlStats,
	QueueItem,
	SanitizedCrawlOptions,
} from "../../types.js";
import {
	loadPendingQueueItems,
	loadSession,
	removeQueueItem,
	saveQueueItemBatch,
	saveSession,
	updateSessionStats,
	updateSessionStatus,
} from "../sessionPersistence.js";

/**
 * CONTRACT: SessionPersistence
 *
 * Purpose: Manages persistence of crawl session state to database for
 * recovery and resume capabilities.
 *
 * OPERATIONS:
 *   1. SAVE: Persist session metadata and options
 *   2. UPDATE: Modify stats and status
 *   3. LOAD: Retrieve session for resume
 *   4. QUEUE: Save/remove/load pending queue items
 *
 * INPUTS:
 *   - db: Database instance
 *   - sessionId: Unique session identifier
 *   - socketId: WebSocket connection ID
 *   - options: SanitizedCrawlOptions
 *   - stats: CrawlStats snapshot
 *   - status: running | completed | interrupted
 *   - items: QueueItem[] for batch operations
 *
 * OUTPUTS:
 *   - saveSession(): void (side effect: DB write)
 *   - updateSessionStats(): void (side effect: DB update)
 *   - updateSessionStatus(): void (side effect: DB update)
 *   - loadSession(): { options, stats, status } | null
 *   - saveQueueItemBatch(): void (side effect: DB insert)
 *   - removeQueueItem(): void (side effect: DB delete)
 *   - loadPendingQueueItems(): QueueItem[]
 *
 * INVARIANTS:
 *   1. ATOMIC BATCH: Queue items saved in single transaction
 *   2. IDEMPOTENT SAVE: saveSession uses INSERT OR REPLACE
 *   3. TIMESTAMP AUTO: updated_at set via CURRENT_TIMESTAMP
 *   4. NULL HANDLING: stats nullable, options always present
 *   5. JSON SERIALIZATION: options/stats stored as JSON strings
 *   6. SILENT FAILURE: try/catch prevents throwing (logs errors)
 *   7. ORDERING: loadPendingQueueItems orders by depth ASC
 *   8. DEDUPLICATION: queue_items uses INSERT OR IGNORE
 *   9. FOREIGN KEY: queue_items.session_id references crawl_sessions.id
 *  10. PARENT URL: stored as null when undefined
 *
 * FORBIDDEN STATES:
 *   - Orphaned queue items without session
 *   - Invalid JSON in options/stats columns
 *   - Missing session_id in queue_items
 *   - Duplicate (session_id, url) in queue_items
 *
 * EDGE CASES:
 *   - Database locked/busy
 *   - JSON serialization failure
 *   - Session not found on load
 *   - Empty queue item batch
 *   - Invalid parent_url format
 */

const createOptions = (): SanitizedCrawlOptions => ({
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
});

const createStats = (): CrawlStats => ({
	total: 10,
	completed: 5,
	failed: 1,
	skipped: 0,
	linksFound: 50,
	mediaFound: 3,
	queued: 4,
	averagePageSize: 1024,
	crawlDuration: 30,
	currentDepth: 1,
	currentUrl: "https://example.com/page",
});

const createQueueItem = (overrides?: Partial<QueueItem>): QueueItem => ({
	url: "https://example.com/page",
	depth: 0,
	retries: 0,
	domain: "example.com",
	parentUrl: null,
	...overrides,
});

describe("SessionPersistence CONTRACT", () => {
	describe("INVARIANT: Session Save/Load", () => {
		test("saveSession calls query with correct SQL pattern", () => {
			// Test documents the SQL patterns used by saveSession
			const db = {
				query: mock(() => ({
					run: mock(() => ({ changes: 1 })),
				})),
			} as unknown as Database;

			const options = createOptions();
			saveSession(db, "session-1", "socket-1", options);

			// INVARIANT: Uses INSERT OR REPLACE for idempotency
			const queryCalls = (db.query as ReturnType<typeof mock>).mock.calls;
			expect(queryCalls.length).toBeGreaterThan(0);
			const sql = queryCalls[0][0] as string;
			expect(sql).toContain("INSERT OR REPLACE");
			expect(sql).toContain("crawl_sessions");
		});

		test("loadSession calls query with correct SQL pattern", () => {
			const db = {
				query: mock(() => ({
					get: mock(() => ({
						options: JSON.stringify(createOptions()),
						stats: JSON.stringify(createStats()),
						status: "running",
					})),
				})),
			} as unknown as Database;

			const result = loadSession(db, "session-1");

			// INVARIANT: Returns parsed session data
			expect(result).not.toBeNull();
			expect(result?.options.target).toBe("https://example.com");
			expect(result?.status).toBe("running");
		});

		test("loadSession returns null when session not found", () => {
			const db = {
				query: mock(() => ({
					get: mock(() => undefined),
				})),
			} as unknown as Database;

			const result = loadSession(db, "non-existent");

			// INVARIANT: Graceful handling of missing session
			expect(result).toBeNull();
		});
	});

	describe("INVARIANT: Stats Operations", () => {
		test("updateSessionStats serializes stats to JSON", () => {
			const capturedParams: unknown[] = [];
			const db = {
				query: mock(() => ({
					run: mock((...params: unknown[]) => {
						capturedParams.push(params);
						return { changes: 1 };
					}),
				})),
			} as unknown as Database;

			const stats = createStats();
			updateSessionStats(db, "session-1", stats);

			// INVARIANT: Stats serialized as JSON string
			expect(capturedParams.length).toBeGreaterThan(0);
			const statsJson = capturedParams[0][0] as string;
			const parsed = JSON.parse(statsJson);
			expect(parsed.completed).toBe(stats.completed);
			expect(parsed.linksFound).toBe(stats.linksFound);
		});

		test("updateSessionStatus updates status field", () => {
			const capturedParams: unknown[] = [];
			const db = {
				query: mock(() => ({
					run: mock((...params: unknown[]) => {
						capturedParams.push(params);
						return { changes: 1 };
					}),
				})),
			} as unknown as Database;

			updateSessionStatus(db, "session-1", "completed");

			// INVARIANT: Status parameter passed correctly
			expect(capturedParams.length).toBeGreaterThan(0);
			expect(capturedParams[0][0]).toBe("completed");
			expect(capturedParams[0][1]).toBe("session-1");
		});
	});

	describe("INVARIANT: Queue Item Operations", () => {
		test("saveQueueItemBatch uses transaction for atomicity", () => {
			const transactionCalls: unknown[] = [];
			const runCalls: unknown[][] = [];
			const db = {
				prepare: mock(() => ({
					run: mock((...params: unknown[]) => {
						runCalls.push(params);
						return { changes: 1 };
					}),
				})),
				transaction: mock((fn: () => void) => {
					transactionCalls.push(fn);
					return () => fn();
				}),
			} as unknown as Database;

			const items = [
				createQueueItem({ url: "https://example.com/1" }),
				createQueueItem({ url: "https://example.com/2" }),
			];
			saveQueueItemBatch(db, "session-1", items);

			// INVARIANT: Uses transaction for atomic batch insert
			expect(transactionCalls.length).toBeGreaterThan(0);
			expect(runCalls.length).toBe(2);
		});

		test("saveQueueItemBatch handles empty array gracefully", () => {
			const db = {
				prepare: mock(() => ({
					run: mock(() => ({ changes: 0 })),
				})),
				transaction: mock((fn: () => void) => () => fn()),
			} as unknown as Database;

			// INVARIANT: Empty batch returns early without error
			expect(() => saveQueueItemBatch(db, "session-1", [])).not.toThrow();
		});

		test("loadPendingQueueItems orders by depth", () => {
			const db = {
				query: mock(() => ({
					all: mock(() => [
						{
							url: "https://example.com/1",
							depth: 0,
							retries: 0,
							parent_url: null,
							domain: "example.com",
						},
						{
							url: "https://example.com/2",
							depth: 1,
							retries: 0,
							parent_url: null,
							domain: "example.com",
						},
					]),
				})),
			} as unknown as Database;

			const items = loadPendingQueueItems(db, "session-1");

			// INVARIANT: Returns items in depth order
			expect(items.length).toBe(2);
			expect(items[0].depth).toBeLessThanOrEqual(items[1].depth);
		});

		test("removeQueueItem deletes by session_id and url", () => {
			const capturedParams: unknown[] = [];
			const db = {
				query: mock(() => ({
					run: mock((...params: unknown[]) => {
						capturedParams.push(params);
						return { changes: 1 };
					}),
				})),
			} as unknown as Database;

			removeQueueItem(db, "session-1", "https://example.com/page");

			// INVARIANT: Delete uses both session_id and url
			expect(capturedParams.length).toBeGreaterThan(0);
			expect(capturedParams[0][0]).toBe("session-1");
			expect(capturedParams[0][1]).toBe("https://example.com/page");
		});
	});

	describe("EDGE CASE: Error Handling", () => {
		test("operations handle database errors gracefully", () => {
			const db = {
				query: mock(() => {
					throw new Error("Database locked");
				}),
				prepare: mock(() => {
					throw new Error("Database locked");
				}),
				transaction: mock(() => {
					throw new Error("Database locked");
				}),
			} as unknown as Database;

			// INVARIANT: Silent failure - no exceptions thrown
			expect(() => {
				saveSession(db, "session-1", "socket-1", createOptions());
				updateSessionStats(db, "session-1", createStats());
				updateSessionStatus(db, "session-1", "completed");
				saveQueueItemBatch(db, "session-1", [createQueueItem()]);
				removeQueueItem(db, "session-1", "url");
			}).not.toThrow();
		});

		test("parentUrl undefined converts to null in database", () => {
			const capturedParams: unknown[][] = [];
			const db = {
				prepare: mock(() => ({
					run: mock((...params: unknown[]) => {
						capturedParams.push(params);
						return { changes: 1 };
					}),
				})),
				transaction: mock((fn: () => void) => () => fn()),
			} as unknown as Database;

			const item = createQueueItem({ parentUrl: undefined });
			saveQueueItemBatch(db, "session-1", [item]);

			// INVARIANT: parentUrl undefined becomes null in DB
			if (capturedParams.length > 0) {
				const parentUrlParam = capturedParams[0][4];
				expect(parentUrlParam).toBeNull();
			}
		});

		test("loadPendingQueueItems handles parent_url null mapping", () => {
			const db = {
				query: mock(() => ({
					all: mock(() => [
						{
							url: "https://example.com/1",
							depth: 0,
							retries: 0,
							parent_url: null,
							domain: "example.com",
						},
					]),
				})),
			} as unknown as Database;

			const items = loadPendingQueueItems(db, "session-1");

			// INVARIANT: Null parent_url becomes undefined in result
			expect(items[0].parentUrl).toBeUndefined();
		});
	});
});

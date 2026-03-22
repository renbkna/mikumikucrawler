import type { CrawlSummary } from "../../../shared/contracts/crawl.js";
import { describe, expect, test } from "bun:test";
import type { CrawlEventEnvelope } from "../../../shared/contracts/events.js";
import { UI_LIMITS } from "../../constants";
import {
	type CrawlControllerAction,
	type CrawlControllerState,
	crawlControllerReducer,
	createInitialCrawlControllerState,
} from "../crawlControllerState";
import { getResumeHydrationActions } from "../useCrawlController";

function reduce(
	state: CrawlControllerState,
	...actions: CrawlControllerAction[]
): CrawlControllerState {
	return actions.reduce(
		(currentState, action) =>
			crawlControllerReducer(currentState, action).state,
		state,
	);
}

function applyEvent(state: CrawlControllerState, envelope: CrawlEventEnvelope) {
	return crawlControllerReducer(state, {
		type: "sseEventReceived",
		envelope,
	});
}

describe("crawlControllerReducer", () => {
	test("ignores stale SSE events for the same crawl", () => {
		const initial = reduce(
			createInitialCrawlControllerState(),
			{ type: "crawlAccepted", crawlId: "crawl-1", kind: "start" },
			{ type: "connectionChanged", connectionState: "connected" },
		);

		const progressEnvelope: CrawlEventEnvelope = {
			type: "crawl.progress",
			crawlId: "crawl-1",
			sequence: 2,
			timestamp: "2026-03-21T12:00:00.000Z",
			payload: {
				counters: {
					pagesScanned: 3,
					successCount: 2,
					failureCount: 1,
					skippedCount: 0,
					linksFound: 8,
					mediaFiles: 0,
					totalDataKb: 12,
				},
				queue: {
					activeRequests: 1,
					queueLength: 4,
					elapsedTime: 4,
					pagesPerSecond: 0.75,
				},
				elapsedSeconds: 4,
				pagesPerSecond: 0.75,
				stopReason: null,
			},
		};
		const staleLogEnvelope: CrawlEventEnvelope = {
			type: "crawl.log",
			crawlId: "crawl-1",
			sequence: 1,
			timestamp: "2026-03-21T12:00:01.000Z",
			payload: {
				message: "[Runtime] stale",
			},
		};

		const afterProgress = applyEvent(initial, progressEnvelope).state;
		const afterStaleLog = applyEvent(afterProgress, staleLogEnvelope).state;

		expect(afterStaleLog).toEqual(afterProgress);
		expect(afterStaleLog.lastSequenceByCrawlId["crawl-1"]).toBe(2);
		expect(afterStaleLog.logs).toHaveLength(0);
	});

	test("marks terminal events as complete and clears pending command state", () => {
		const initial = reduce(
			createInitialCrawlControllerState(),
			{ type: "crawlAccepted", crawlId: "crawl-1", kind: "start" },
			{ type: "commandStarted", kind: "stop" },
		);

		const completedEnvelope: CrawlEventEnvelope = {
			type: "crawl.completed",
			crawlId: "crawl-1",
			sequence: 3,
			timestamp: "2026-03-21T12:01:00.000Z",
			payload: {
				counters: {
					pagesScanned: 6,
					successCount: 5,
					failureCount: 1,
					skippedCount: 0,
					linksFound: 11,
					mediaFiles: 2,
					totalDataKb: 42,
				},
			},
		};

		const transition = applyEvent(initial, completedEnvelope);

		expect(transition.state.runPhase).toBe("completed");
		expect(transition.state.connectionState).toBe("disconnected");
		expect(transition.state.progress).toBe(100);
		expect(transition.state.lastCommand).toEqual({
			kind: "none",
			status: "idle",
			error: null,
		});
		expect(transition.effects).toEqual([
			{
				type: "toast",
				level: "success",
				message: "Crawl completed! Scanned 6 pages",
				timeout: 5000,
			},
		]);
	});

	test("represents stop failures explicitly and returns to running", () => {
		const initial = reduce(
			createInitialCrawlControllerState(),
			{ type: "crawlAccepted", crawlId: "crawl-1", kind: "start" },
			{ type: "commandStarted", kind: "stop" },
		);

		const transition = crawlControllerReducer(initial, {
			type: "commandFailed",
			kind: "stop",
			error: "Stop failed",
		});

		expect(transition.state.runPhase).toBe("running");
		expect(transition.state.lastCommand).toEqual({
			kind: "stop",
			status: "error",
			error: "Stop failed",
		});
		expect(transition.effects).toEqual([
			{
				type: "toast",
				level: "error",
				message: "Stop failed",
			},
		]);
	});

	test("records successful non-terminal commands without leaving them pending", () => {
		const initial = reduce(createInitialCrawlControllerState(), {
			type: "crawlAccepted",
			crawlId: "crawl-1",
			kind: "start",
		});

		const transition = crawlControllerReducer(initial, {
			type: "commandSucceeded",
			kind: "stop",
		});

		expect(transition.state.runPhase).toBe("stopping");
		expect(transition.state.lastCommand).toEqual({
			kind: "stop",
			status: "success",
			error: null,
		});
		expect(transition.effects).toEqual([]);
	});

	test("caps logs and emits the static fallback warning only once", () => {
		let state = createInitialCrawlControllerState();
		let warningCount = 0;

		for (let index = 0; index < UI_LIMITS.MAX_LOGS + 10; index += 1) {
			const transition = crawlControllerReducer(state, {
				type: "logAppended",
				message:
					index === 1
						? "[Fetch] Falling back to static crawling for https://example.com"
						: `[Runtime] log ${index}`,
			});
			state = transition.state;
			warningCount += transition.effects.filter(
				(effect) => effect.type === "toast" && effect.level === "warning",
			).length;
		}

		const repeatedFallback = crawlControllerReducer(state, {
			type: "logAppended",
			message:
				"[Fetch] Falling back to static crawling for https://example.com",
		});

		expect(state.logs).toHaveLength(UI_LIMITS.MAX_LOGS);
		expect(warningCount).toBe(1);
		expect(repeatedFallback.effects).toEqual([]);
	});

	test("crawl.started transitions runPhase to running and appends log", () => {
		const initial = reduce(
			createInitialCrawlControllerState(),
			{ type: "crawlAccepted", crawlId: "crawl-1", kind: "start" },
			{ type: "connectionChanged", connectionState: "connected" },
		);

		const transition = applyEvent(initial, {
			type: "crawl.started",
			crawlId: "crawl-1",
			sequence: 1,
			timestamp: "2026-03-21T12:00:00.000Z",
			payload: { target: "https://example.com", resume: false },
		});

		expect(transition.state.runPhase).toBe("running");
		expect(transition.state.logs).toHaveLength(1);
		expect(transition.state.logs[0]).toContain(
			"Crawl started for https://example.com",
		);
	});

	test("crawl.started with resume flag produces resume-specific log", () => {
		const initial = reduce(createInitialCrawlControllerState(), {
			type: "crawlAccepted",
			crawlId: "crawl-1",
			kind: "resume",
		});

		const transition = applyEvent(initial, {
			type: "crawl.started",
			crawlId: "crawl-1",
			sequence: 1,
			timestamp: "2026-03-21T12:00:00.000Z",
			payload: { target: "https://example.com", resume: true },
		});

		expect(transition.state.logs[0]).toContain("[Resume]");
	});

	test("crawl.page prepends page to crawledPages", () => {
		const initial = reduce(createInitialCrawlControllerState(), {
			type: "crawlAccepted",
			crawlId: "crawl-1",
			kind: "start",
		});

		const t1 = applyEvent(initial, {
			type: "crawl.page",
			crawlId: "crawl-1",
			sequence: 1,
			timestamp: "2026-03-21T12:00:00.000Z",
			payload: { id: 1, url: "https://example.com/a" },
		});
		const t2 = applyEvent(t1.state, {
			type: "crawl.page",
			crawlId: "crawl-1",
			sequence: 2,
			timestamp: "2026-03-21T12:00:01.000Z",
			payload: { id: 2, url: "https://example.com/b", title: "Page B" },
		});

		expect(t2.state.crawledPages).toHaveLength(2);
		// Most recent page is first (prepended)
		expect(t2.state.crawledPages[0].url).toBe("https://example.com/b");
		expect(t2.state.crawledPages[1].url).toBe("https://example.com/a");
	});

	test("crawl.progress updates stats, queue, and progress", () => {
		const initial = reduce(createInitialCrawlControllerState(), {
			type: "crawlAccepted",
			crawlId: "crawl-1",
			kind: "start",
		});

		const transition = applyEvent(initial, {
			type: "crawl.progress",
			crawlId: "crawl-1",
			sequence: 1,
			timestamp: "2026-03-21T12:00:05.000Z",
			payload: {
				counters: {
					pagesScanned: 10,
					successCount: 8,
					failureCount: 1,
					skippedCount: 1,
					linksFound: 25,
					mediaFiles: 3,
					totalDataKb: 64,
				},
				queue: {
					activeRequests: 2,
					queueLength: 5,
					elapsedTime: 5,
					pagesPerSecond: 2,
				},
				elapsedSeconds: 5,
				pagesPerSecond: 2,
				stopReason: null,
			},
		});

		expect(transition.state.stats.pagesScanned).toBe(10);
		expect(transition.state.stats.linksFound).toBe(25);
		expect(transition.state.stats.mediaFiles).toBe(3);
		expect(transition.state.queueStats).toEqual({
			activeRequests: 2,
			queueLength: 5,
			elapsedTime: 5,
			pagesPerSecond: 2,
		});
		expect(transition.state.progress).toBeGreaterThan(0);
		expect(transition.state.runPhase).toBe("running");
	});

	test("crawl.failed sets failed phase with error toast", () => {
		const initial = reduce(createInitialCrawlControllerState(), {
			type: "crawlAccepted",
			crawlId: "crawl-1",
			kind: "start",
		});

		const transition = applyEvent(initial, {
			type: "crawl.failed",
			crawlId: "crawl-1",
			sequence: 5,
			timestamp: "2026-03-21T12:01:00.000Z",
			payload: {
				error: "Circuit breaker tripped",
				counters: {
					pagesScanned: 20,
					successCount: 0,
					failureCount: 20,
					skippedCount: 0,
					linksFound: 0,
					mediaFiles: 0,
					totalDataKb: 0,
				},
			},
		});

		expect(transition.state.runPhase).toBe("failed");
		expect(transition.state.connectionState).toBe("disconnected");
		expect(transition.state.progress).toBe(100);
		expect(transition.effects).toEqual([
			{
				type: "toast",
				level: "error",
				message: "Circuit breaker tripped",
			},
		]);
	});

	test("crawl.stopped sets stopped phase with info toast", () => {
		const initial = reduce(
			createInitialCrawlControllerState(),
			{ type: "crawlAccepted", crawlId: "crawl-1", kind: "start" },
			{ type: "commandStarted", kind: "stop" },
		);

		const transition = applyEvent(initial, {
			type: "crawl.stopped",
			crawlId: "crawl-1",
			sequence: 5,
			timestamp: "2026-03-21T12:01:00.000Z",
			payload: {
				stopReason: "User requested stop",
				counters: {
					pagesScanned: 15,
					successCount: 12,
					failureCount: 2,
					skippedCount: 1,
					linksFound: 30,
					mediaFiles: 1,
					totalDataKb: 90,
				},
			},
		});

		expect(transition.state.runPhase).toBe("stopped");
		expect(transition.state.connectionState).toBe("disconnected");
		expect(transition.effects).toEqual([
			{
				type: "toast",
				level: "info",
				message: "User requested stop",
			},
		]);
	});

	test("interrupted sessions state machine: loading → loaded → delete → deleted", () => {
		let state = createInitialCrawlControllerState();

		// Loading
		state = crawlControllerReducer(state, {
			type: "interruptedSessionsLoading",
		}).state;
		expect(state.interruptedSessions.isLoading).toBe(true);
		expect(state.interruptedSessions.error).toBeNull();

		// Loaded
		const sessions = [
			{
				id: "s-1",
				target: "https://a.com",
				status: "interrupted",
				pagesScanned: 5,
				createdAt: "2026-03-21T12:00:00.000Z",
				updatedAt: "2026-03-21T12:01:00.000Z",
			},
			{
				id: "s-2",
				target: "https://b.com",
				status: "interrupted",
				pagesScanned: 10,
				createdAt: "2026-03-20T12:00:00.000Z",
				updatedAt: "2026-03-20T12:01:00.000Z",
			},
		];
		state = crawlControllerReducer(state, {
			type: "interruptedSessionsLoaded",
			sessions,
		}).state;
		expect(state.interruptedSessions.items).toHaveLength(2);
		expect(state.interruptedSessions.isLoading).toBe(false);

		// Deleting
		state = crawlControllerReducer(state, {
			type: "interruptedSessionDeleting",
			sessionId: "s-1",
		}).state;
		expect(state.interruptedSessions.deletingId).toBe("s-1");

		// Deleted
		state = crawlControllerReducer(state, {
			type: "interruptedSessionDeleted",
			sessionId: "s-1",
		}).state;
		expect(state.interruptedSessions.items).toHaveLength(1);
		expect(state.interruptedSessions.items[0].id).toBe("s-2");
		expect(state.interruptedSessions.deletingId).toBeNull();
	});

	test("interrupted sessions failure preserves existing items", () => {
		const sessions = [
			{
				id: "s-1",
				target: "https://a.com",
				status: "interrupted",
				pagesScanned: 5,
				createdAt: "2026-03-21T12:00:00.000Z",
				updatedAt: "2026-03-21T12:01:00.000Z",
			},
		];
		let state = crawlControllerReducer(createInitialCrawlControllerState(), {
			type: "interruptedSessionsLoaded",
			sessions,
		}).state;

		state = crawlControllerReducer(state, {
			type: "interruptedSessionsFailed",
			error: "Network error",
		}).state;

		expect(state.interruptedSessions.items).toHaveLength(1);
		expect(state.interruptedSessions.error).toBe("Network error");
		expect(state.interruptedSessions.isLoading).toBe(false);
	});

	test("liveStateReset clears crawl state but preserves target and options", () => {
		let state = reduce(
			createInitialCrawlControllerState(),
			{ type: "targetChanged", target: "https://example.com" },
			{ type: "crawlAccepted", crawlId: "crawl-1", kind: "start" },
		);

		// Add some live state
		state = applyEvent(state, {
			type: "crawl.page",
			crawlId: "crawl-1",
			sequence: 1,
			timestamp: "2026-03-21T12:00:00.000Z",
			payload: { id: 1, url: "https://example.com" },
		}).state;

		state = crawlControllerReducer(state, { type: "liveStateReset" }).state;

		expect(state.activeCrawlId).toBeNull();
		expect(state.crawledPages).toHaveLength(0);
		expect(state.logs).toHaveLength(0);
		expect(state.progress).toBe(0);
		expect(state.runPhase).toBe("idle");
	});

	test("full lifecycle: start → progress → pages → completed", () => {
		let state = reduce(
			createInitialCrawlControllerState(),
			{ type: "crawlAccepted", crawlId: "lifecycle-1", kind: "start" },
			{ type: "connectionChanged", connectionState: "connected" },
		);

		// Started
		state = applyEvent(state, {
			type: "crawl.started",
			crawlId: "lifecycle-1",
			sequence: 1,
			timestamp: "2026-03-21T12:00:00.000Z",
			payload: { target: "https://example.com", resume: false },
		}).state;
		expect(state.runPhase).toBe("running");

		// Progress
		state = applyEvent(state, {
			type: "crawl.progress",
			crawlId: "lifecycle-1",
			sequence: 2,
			timestamp: "2026-03-21T12:00:01.000Z",
			payload: {
				counters: {
					pagesScanned: 1,
					successCount: 1,
					failureCount: 0,
					skippedCount: 0,
					linksFound: 3,
					mediaFiles: 0,
					totalDataKb: 8,
				},
				queue: {
					activeRequests: 1,
					queueLength: 2,
					elapsedTime: 1,
					pagesPerSecond: 1,
				},
				elapsedSeconds: 1,
				pagesPerSecond: 1,
				stopReason: null,
			},
		}).state;
		expect(state.stats.pagesScanned).toBe(1);

		// Page
		state = applyEvent(state, {
			type: "crawl.page",
			crawlId: "lifecycle-1",
			sequence: 3,
			timestamp: "2026-03-21T12:00:02.000Z",
			payload: { id: 1, url: "https://example.com" },
		}).state;
		expect(state.crawledPages).toHaveLength(1);

		// Completed
		const completed = applyEvent(state, {
			type: "crawl.completed",
			crawlId: "lifecycle-1",
			sequence: 4,
			timestamp: "2026-03-21T12:00:03.000Z",
			payload: {
				counters: {
					pagesScanned: 3,
					successCount: 3,
					failureCount: 0,
					skippedCount: 0,
					linksFound: 5,
					mediaFiles: 1,
					totalDataKb: 24,
				},
			},
		});

		expect(completed.state.runPhase).toBe("completed");
		expect(completed.state.progress).toBe(100);
		expect(completed.state.connectionState).toBe("disconnected");
		expect(completed.state.crawledPages).toHaveLength(1); // pages preserved
		expect(
			completed.effects.some(
				(e) => e.type === "toast" && e.level === "success",
			),
		).toBe(true);
	});

	test("resume hydration replaces local form state with persisted crawl settings", () => {
		const summary: CrawlSummary = {
			id: "crawl-1",
			target: "https://resume.example/path",
			status: "running",
			options: {
				target: "https://resume.example/path",
				crawlMethod: "media",
				crawlDepth: 4,
				crawlDelay: 750,
				maxPages: 42,
				maxPagesPerDomain: 7,
				maxConcurrentRequests: 3,
				retryLimit: 2,
				dynamic: true,
				respectRobots: false,
				contentOnly: true,
				saveMedia: true,
			},
			counters: {
				pagesScanned: 5,
				successCount: 4,
				failureCount: 1,
				skippedCount: 0,
				linksFound: 12,
				mediaFiles: 3,
				totalDataKb: 99,
			},
			createdAt: "2026-03-21T12:00:00.000Z",
			startedAt: "2026-03-21T12:00:10.000Z",
			updatedAt: "2026-03-21T12:01:00.000Z",
			completedAt: null,
			stopReason: null,
			resumable: true,
		};
		const initial = reduce(
			createInitialCrawlControllerState(),
			{ type: "targetChanged", target: "https://draft.example" },
			{
				type: "crawlOptionsChanged",
				crawlOptions: {
					target: "https://draft.example",
					crawlMethod: "links",
					crawlDepth: 1,
					crawlDelay: 0,
					maxPages: 10,
					maxPagesPerDomain: 0,
					maxConcurrentRequests: 1,
					retryLimit: 0,
					dynamic: false,
					respectRobots: true,
					contentOnly: false,
					saveMedia: false,
				},
			},
		);

		const resumed = reduce(initial, ...getResumeHydrationActions(summary));

		expect(resumed.target).toBe(summary.target);
		expect(resumed.crawlOptions).toEqual(summary.options);
	});
});

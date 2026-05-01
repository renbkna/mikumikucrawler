import type {
	CrawlSummary,
	ResumableSessionSummary,
} from "../../../shared/contracts/crawl.js";
import { describe, expect, test } from "bun:test";
import type { CrawlEventEnvelope } from "../../../shared/contracts/events.js";
import { UI_LIMITS } from "../../constants";
import {
	type CrawlControllerAction,
	type CrawlControllerState,
	crawlControllerReducer,
	createInitialCrawlControllerState,
	getCrawlCommandAvailability,
} from "../crawlControllerState";
import {
	getResumeHydrationActions,
	shouldSettleActiveSubscription,
} from "../useCrawlController";

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
	test("terminal subscription teardown only settles the active crawl subscription", () => {
		const oldTerminal: CrawlEventEnvelope = {
			type: "crawl.completed",
			crawlId: "old-crawl",
			sequence: 3,
			timestamp: "2026-03-21T12:01:00.000Z",
			payload: {
				counters: {
					pagesScanned: 1,
					successCount: 1,
					failureCount: 0,
					skippedCount: 0,
					linksFound: 0,
					mediaFiles: 0,
					totalDataKb: 1,
				},
			},
		};

		expect(shouldSettleActiveSubscription("new-crawl", oldTerminal)).toBe(
			false,
		);
		expect(shouldSettleActiveSubscription("old-crawl", oldTerminal)).toBe(true);
	});

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

	test("ignores late non-terminal SSE events after terminal state", () => {
		const completed = applyEvent(
			reduce(createInitialCrawlControllerState(), {
				type: "crawlAccepted",
				crawlId: "crawl-1",
				kind: "start",
			}),
			{
				type: "crawl.completed",
				crawlId: "crawl-1",
				sequence: 5,
				timestamp: "2026-03-21T12:01:00.000Z",
				payload: {
					counters: {
						pagesScanned: 1,
						successCount: 1,
						failureCount: 0,
						skippedCount: 0,
						linksFound: 0,
						mediaFiles: 0,
						totalDataKb: 1,
					},
				},
			},
		).state;

		const lateLog = applyEvent(completed, {
			type: "crawl.log",
			crawlId: "crawl-1",
			sequence: 6,
			timestamp: "2026-03-21T12:01:01.000Z",
			payload: { message: "[Runtime] late" },
		}).state;

		expect(lateLog).toEqual(completed);
	});

	test("ignores events from a previous crawl after a new crawl is accepted", () => {
		const nextCrawl = reduce(
			createInitialCrawlControllerState(),
			{ type: "crawlAccepted", crawlId: "crawl-1", kind: "start" },
			{ type: "liveStateReset" },
			{ type: "crawlAccepted", crawlId: "crawl-2", kind: "start" },
		);

		const afterOldEvent = applyEvent(nextCrawl, {
			type: "crawl.log",
			crawlId: "crawl-1",
			sequence: 10,
			timestamp: "2026-03-21T12:01:01.000Z",
			payload: { message: "[Runtime] old crawl" },
		}).state;

		expect(afterOldEvent).toEqual(nextCrawl);
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

	test("resume failures keep paused crawl state attached", () => {
		const paused = applyEvent(
			reduce(createInitialCrawlControllerState(), {
				type: "crawlAccepted",
				crawlId: "crawl-1",
				kind: "start",
			}),
			{
				type: "crawl.paused",
				crawlId: "crawl-1",
				sequence: 3,
				timestamp: "2026-03-21T12:01:00.000Z",
				payload: {
					stopReason: "Pause requested",
					counters: {
						pagesScanned: 2,
						successCount: 2,
						failureCount: 0,
						skippedCount: 0,
						linksFound: 4,
						mediaFiles: 0,
						totalDataKb: 12,
					},
				},
			},
		).state;

		const failed = reduce(
			paused,
			{ type: "commandStarted", kind: "resume" },
			{ type: "commandFailed", kind: "resume", error: "No longer resumable" },
		);

		expect(failed.activeCrawlId).toBe("crawl-1");
		expect(failed.runPhase).toBe("paused");
		expect(failed.stats.pagesScanned).toBe(2);
		expect(failed.lastCommand).toEqual({
			kind: "resume",
			status: "error",
			error: "No longer resumable",
		});
	});

	test("start failures keep the previously visible crawl state attached", () => {
		const completed = applyEvent(
			reduce(createInitialCrawlControllerState(), {
				type: "crawlAccepted",
				crawlId: "crawl-1",
				kind: "start",
			}),
			{
				type: "crawl.completed",
				crawlId: "crawl-1",
				sequence: 3,
				timestamp: "2026-03-21T12:01:00.000Z",
				payload: {
					counters: {
						pagesScanned: 2,
						successCount: 2,
						failureCount: 0,
						skippedCount: 0,
						linksFound: 4,
						mediaFiles: 0,
						totalDataKb: 12,
					},
				},
			},
		).state;

		const failed = reduce(
			completed,
			{ type: "commandStarted", kind: "start" },
			{ type: "commandFailed", kind: "start", error: "Create failed" },
		);

		expect(failed.activeCrawlId).toBe("crawl-1");
		expect(failed.runPhase).toBe("completed");
		expect(failed.stats.pagesScanned).toBe(2);
		expect(failed.lastCommand).toEqual({
			kind: "start",
			status: "error",
			error: "Create failed",
		});
	});

	test("records successful non-terminal commands without leaving them pending", () => {
		const initial = reduce(createInitialCrawlControllerState(), {
			type: "crawlAccepted",
			crawlId: "crawl-1",
			kind: "start",
		});

		const pending = crawlControllerReducer(initial, {
			type: "commandStarted",
			kind: "stop",
		}).state;
		const transition = crawlControllerReducer(pending, {
			type: "commandSucceeded",
			kind: "stop",
		});

		expect(transition.state.runPhase).toBe("pausing");
		expect(transition.state.lastCommand).toEqual({
			kind: "stop",
			status: "success",
			error: null,
		});
		expect(transition.effects).toEqual([]);
	});

	test("force stop command enters stopping instead of pause state", () => {
		const initial = reduce(createInitialCrawlControllerState(), {
			type: "crawlAccepted",
			crawlId: "crawl-1",
			kind: "start",
		});

		const pending = crawlControllerReducer(initial, {
			type: "commandStarted",
			kind: "forceStop",
		}).state;
		const succeeded = crawlControllerReducer(pending, {
			type: "commandSucceeded",
			kind: "forceStop",
		}).state;

		expect(pending.runPhase).toBe("stopping");
		expect(pending.lastCommand).toEqual({
			kind: "forceStop",
			status: "pending",
			error: null,
		});
		expect(succeeded.runPhase).toBe("stopping");
		expect(succeeded.lastCommand).toEqual({
			kind: "forceStop",
			status: "success",
			error: null,
		});
	});

	test("stop success does not move terminal stopped state back to pausing", () => {
		const stopped = applyEvent(
			reduce(
				createInitialCrawlControllerState(),
				{ type: "crawlAccepted", crawlId: "crawl-1", kind: "start" },
				{ type: "commandStarted", kind: "stop" },
			),
			{
				type: "crawl.stopped",
				crawlId: "crawl-1",
				sequence: 5,
				timestamp: "2026-03-21T12:01:00.000Z",
				payload: {
					stopReason: "Force stop requested",
					counters: {
						pagesScanned: 2,
						successCount: 1,
						failureCount: 0,
						skippedCount: 1,
						linksFound: 3,
						mediaFiles: 0,
						totalDataKb: 10,
					},
				},
			},
		).state;

		const transition = crawlControllerReducer(stopped, {
			type: "commandSucceeded",
			kind: "stop",
		});

		expect(transition.state.runPhase).toBe("stopped");
		expect(transition.effects).toEqual([]);
	});

	test("crawl.paused SSE settles live state without completing progress", () => {
		const initial = reduce(
			createInitialCrawlControllerState(),
			{ type: "crawlAccepted", crawlId: "crawl-1", kind: "start" },
			{ type: "commandStarted", kind: "stop" },
		);

		const transition = applyEvent(initial, {
			type: "crawl.paused",
			crawlId: "crawl-1",
			sequence: 4,
			timestamp: "2026-03-21T12:01:00.000Z",
			payload: {
				stopReason: "Pause requested",
				counters: {
					pagesScanned: 4,
					successCount: 3,
					failureCount: 0,
					skippedCount: 1,
					linksFound: 9,
					mediaFiles: 0,
					totalDataKb: 24,
				},
			},
		});

		expect(transition.state.runPhase).toBe("paused");
		expect(transition.state.connectionState).toBe("disconnected");
		expect(transition.state.progress).toBe(8);
		expect(transition.state.stats.pagesScanned).toBe(4);
		expect(transition.state.lastCommand).toEqual({
			kind: "none",
			status: "idle",
			error: null,
		});
		expect(transition.effects).toEqual([
			{
				type: "toast",
				level: "info",
				message: "Pause requested",
			},
		]);
	});

	test("command availability keeps startup force-stop reachable without duplicate pause", () => {
		const starting = reduce(createInitialCrawlControllerState(), {
			type: "crawlAccepted",
			crawlId: "crawl-1",
			kind: "start",
		});
		expect(getCrawlCommandAvailability(starting)).toEqual({
			canStart: false,
			isAttacking: true,
			canPause: false,
			canForceStop: true,
		});

		const pausing = reduce(starting, { type: "commandStarted", kind: "stop" });
		expect(getCrawlCommandAvailability(pausing)).toEqual({
			canStart: false,
			isAttacking: true,
			canPause: false,
			canForceStop: true,
		});

		const forceStopping = reduce(pausing, {
			type: "commandStarted",
			kind: "forceStop",
		});
		expect(getCrawlCommandAvailability(forceStopping)).toEqual({
			canStart: false,
			isAttacking: true,
			canPause: false,
			canForceStop: false,
		});

		const resumePending = reduce(
			applyEvent(starting, {
				type: "crawl.paused",
				crawlId: "crawl-1",
				sequence: 2,
				timestamp: "2026-03-21T12:01:00.000Z",
				payload: {
					stopReason: "Pause requested",
					counters: {
						pagesScanned: 1,
						successCount: 1,
						failureCount: 0,
						skippedCount: 0,
						linksFound: 0,
						mediaFiles: 0,
						totalDataKb: 1,
					},
				},
			}).state,
			{ type: "commandStarted", kind: "resume" },
		);
		expect(getCrawlCommandAvailability(resumePending)).toEqual({
			canStart: false,
			isAttacking: false,
			canPause: false,
			canForceStop: false,
		});
	});

	test("new commands cannot replace an existing pending command", () => {
		const refreshPending = reduce(createInitialCrawlControllerState(), {
			type: "commandStarted",
			kind: "refresh",
		});

		const attemptedResume = crawlControllerReducer(refreshPending, {
			type: "commandStarted",
			kind: "resume",
		});

		expect(attemptedResume.state.lastCommand).toEqual({
			kind: "refresh",
			status: "pending",
			error: null,
		});
		expect(getCrawlCommandAvailability(attemptedResume.state)).toEqual({
			canStart: false,
			isAttacking: false,
			canPause: false,
			canForceStop: false,
		});
	});

	test("terminal crawls remain startable even after the SSE stream is closed", () => {
		const completed = applyEvent(
			reduce(createInitialCrawlControllerState(), {
				type: "crawlAccepted",
				crawlId: "crawl-1",
				kind: "start",
			}),
			{
				type: "crawl.completed",
				crawlId: "crawl-1",
				sequence: 2,
				timestamp: "2026-03-21T12:01:00.000Z",
				payload: {
					counters: {
						pagesScanned: 1,
						successCount: 1,
						failureCount: 0,
						skippedCount: 0,
						linksFound: 0,
						mediaFiles: 0,
						totalDataKb: 1,
					},
				},
			},
		).state;

		expect(completed.connectionState).toBe("disconnected");
		expect(getCrawlCommandAvailability(completed).canStart).toBe(true);
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

	test("crawl.started preserves a pause requested during startup", () => {
		const initial = reduce(
			createInitialCrawlControllerState(),
			{ type: "crawlAccepted", crawlId: "crawl-1", kind: "start" },
			{ type: "commandStarted", kind: "stop" },
		);

		const transition = applyEvent(initial, {
			type: "crawl.started",
			crawlId: "crawl-1",
			sequence: 1,
			timestamp: "2026-03-21T12:00:00.000Z",
			payload: { target: "https://example.com", resume: false },
		});

		expect(transition.state.runPhase).toBe("pausing");
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

	test("crawl.progress uses the accepted run options instead of mutable form options", () => {
		const initial = reduce(
			createInitialCrawlControllerState(),
			{
				type: "crawlOptionsChanged",
				crawlOptions: {
					...createInitialCrawlControllerState().crawlOptions,
					maxPages: 10,
				},
			},
			{
				type: "crawlAccepted",
				crawlId: "crawl-1",
				kind: "start",
				crawlOptions: {
					...createInitialCrawlControllerState().crawlOptions,
					maxPages: 10,
				},
			},
			{
				type: "crawlOptionsChanged",
				crawlOptions: {
					...createInitialCrawlControllerState().crawlOptions,
					maxPages: 100,
				},
			},
		);

		const transition = applyEvent(initial, {
			type: "crawl.progress",
			crawlId: "crawl-1",
			sequence: 1,
			timestamp: "2026-03-21T12:00:05.000Z",
			payload: {
				counters: {
					pagesScanned: 5,
					successCount: 5,
					failureCount: 0,
					skippedCount: 0,
					linksFound: 10,
					mediaFiles: 0,
					totalDataKb: 20,
				},
				queue: {
					activeRequests: 0,
					queueLength: 0,
					elapsedTime: 5,
					pagesPerSecond: 1,
				},
				elapsedSeconds: 5,
				pagesPerSecond: 1,
				stopReason: null,
			},
		});

		expect(transition.state.progress).toBe(50);
		expect(transition.state.crawlOptions.maxPages).toBe(100);
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

	test("resumable sessions state machine: loading -> loaded -> delete -> deleted", () => {
		let state = createInitialCrawlControllerState();

		// Loading
		state = crawlControllerReducer(state, {
			type: "resumableSessionsLoading",
			requestId: 1,
		}).state;
		expect(state.resumableSessions.isLoading).toBe(true);
		expect(state.resumableSessions.error).toBeNull();

		// Loaded
		const sessions: ResumableSessionSummary[] = [
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
			type: "resumableSessionsLoaded",
			requestId: 1,
			sessions,
		}).state;
		expect(state.resumableSessions.items).toHaveLength(2);
		expect(state.resumableSessions.isLoading).toBe(false);

		// Deleting
		state = crawlControllerReducer(state, {
			type: "resumableSessionDeleting",
			sessionId: "s-1",
		}).state;
		expect(state.resumableSessions.deletingId).toBe("s-1");

		// Deleted
		state = crawlControllerReducer(state, {
			type: "resumableSessionDeleted",
			sessionId: "s-1",
		}).state;
		expect(state.resumableSessions.items).toHaveLength(1);
		expect(state.resumableSessions.items[0].id).toBe("s-2");
		expect(state.resumableSessions.deletingId).toBeNull();
	});

	test("resumable deletes are single-flight and stale completions cannot clear the active row", () => {
		const sessions: ResumableSessionSummary[] = [
			{
				id: "s-1",
				target: "https://a.com",
				status: "paused",
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
		let state = reduce(
			createInitialCrawlControllerState(),
			{ type: "resumableSessionsLoading", requestId: 1 },
			{ type: "resumableSessionsLoaded", requestId: 1, sessions },
		);

		state = crawlControllerReducer(state, {
			type: "resumableSessionDeleting",
			sessionId: "s-1",
		}).state;
		const afterFirstDelete = state;

		state = crawlControllerReducer(state, {
			type: "resumableSessionDeleting",
			sessionId: "s-2",
		}).state;
		expect(state).toEqual(afterFirstDelete);

		state = crawlControllerReducer(state, {
			type: "resumableSessionDeleteFailed",
			sessionId: "s-2",
			error: "Delete failed late",
		}).state;
		expect(state.resumableSessions.deletingId).toBe("s-1");
		expect(state.resumableSessions.error).toBeNull();

		state = crawlControllerReducer(state, {
			type: "resumableSessionDeleted",
			sessionId: "s-1",
		}).state;
		expect(state.resumableSessions.deletingId).toBeNull();
		expect(state.resumableSessions.items.map((session) => session.id)).toEqual([
			"s-2",
		]);
	});

	test("deleting the active paused resumable session clears selected crawl state", () => {
		const sessions: ResumableSessionSummary[] = [
			{
				id: "active-crawl",
				target: "https://active.example",
				status: "paused",
				pagesScanned: 1,
				createdAt: "2026-03-21T12:00:00.000Z",
				updatedAt: "2026-03-21T12:01:00.000Z",
			},
		];
		let state = reduce(
			createInitialCrawlControllerState(),
			{ type: "crawlAccepted", crawlId: "active-crawl", kind: "start" },
			{ type: "resumableSessionsLoading", requestId: 1 },
			{ type: "resumableSessionsLoaded", requestId: 1, sessions },
		);

		state = applyEvent(state, {
			type: "crawl.page",
			crawlId: "active-crawl",
			sequence: 1,
			timestamp: "2026-03-21T12:00:01.000Z",
			payload: {
				id: 1,
				url: "https://active.example/page",
				title: "active",
			},
		}).state;
		state = applyEvent(state, {
			type: "crawl.paused",
			crawlId: "active-crawl",
			sequence: 2,
			timestamp: "2026-03-21T12:00:02.000Z",
			payload: {
				stopReason: "Pause requested",
				counters: {
					pagesScanned: 1,
					successCount: 1,
					failureCount: 0,
					skippedCount: 0,
					linksFound: 0,
					mediaFiles: 0,
					totalDataKb: 1,
				},
			},
		}).state;

		expect(state.activeCrawlId).toBe("active-crawl");
		expect(state.runPhase).toBe("paused");
		expect(state.crawledPages).toHaveLength(1);

		state = reduce(state, {
			type: "resumableSessionDeleted",
			sessionId: "active-crawl",
		});

		expect(state.activeCrawlId).toBeNull();
		expect(state.runPhase).toBe("idle");
		expect(state.crawledPages).toHaveLength(0);
		expect(state.resumableSessions.items).toHaveLength(0);
	});

	test("resume success removes the resumable row without clearing active crawl state", () => {
		const sessions: ResumableSessionSummary[] = [
			{
				id: "active-crawl",
				target: "https://active.example",
				status: "paused",
				pagesScanned: 1,
				createdAt: "2026-03-21T12:00:00.000Z",
				updatedAt: "2026-03-21T12:01:00.000Z",
			},
		];

		const state = reduce(
			createInitialCrawlControllerState(),
			{ type: "resumableSessionsLoading", requestId: 1 },
			{ type: "resumableSessionsLoaded", requestId: 1, sessions },
			{ type: "resumableSessionResuming", sessionId: "active-crawl" },
			{ type: "liveStateReset" },
			{ type: "targetChanged", target: "https://active.example" },
			{ type: "crawlAccepted", crawlId: "active-crawl", kind: "resume" },
			{ type: "resumableSessionRemoved", sessionId: "active-crawl" },
		);

		expect(state.activeCrawlId).toBe("active-crawl");
		expect(state.runPhase).toBe("starting");
		expect(state.resumableSessions.items).toHaveLength(0);
		expect(state.resumableSessions.resumingId).toBeNull();
	});

	test("resumable resume locks block refresh and unrelated delete release", () => {
		let state = createInitialCrawlControllerState();
		state = crawlControllerReducer(state, {
			type: "resumableSessionResuming",
			sessionId: "s-2",
		}).state;
		const locked = state;

		state = crawlControllerReducer(state, {
			type: "resumableSessionDeleting",
			sessionId: "s-1",
		}).state;
		expect(state).toEqual(locked);

		state = crawlControllerReducer(state, {
			type: "resumableSessionDeleted",
			sessionId: "s-1",
		}).state;
		expect(state.resumableSessions.resumingId).toBe("s-2");

		state = crawlControllerReducer(state, {
			type: "resumableSessionResumeFinished",
			sessionId: "s-2",
		}).state;
		expect(state.resumableSessions.resumingId).toBeNull();
	});

	test("resumable refreshes preserve an in-flight delete lock", () => {
		const sessions: ResumableSessionSummary[] = [
			{
				id: "s-1",
				target: "https://a.com",
				status: "paused",
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
		let state = reduce(
			createInitialCrawlControllerState(),
			{ type: "resumableSessionsLoading", requestId: 1 },
			{ type: "resumableSessionsLoaded", requestId: 1, sessions },
			{ type: "resumableSessionDeleting", sessionId: "s-1" },
			{ type: "resumableSessionsLoading", requestId: 2 },
			{ type: "resumableSessionsLoaded", requestId: 2, sessions },
		);

		expect(state.resumableSessions.deletingId).toBe("s-1");

		state = crawlControllerReducer(state, {
			type: "resumableSessionDeleteFailed",
			sessionId: "s-1",
			error: "Delete failed",
		}).state;

		expect(state.resumableSessions.deletingId).toBeNull();
		expect(state.resumableSessions.error).toBe("Delete failed");
	});

	test("resumable sessions failure preserves existing items", () => {
		const sessions: ResumableSessionSummary[] = [
			{
				id: "s-1",
				target: "https://a.com",
				status: "interrupted",
				pagesScanned: 5,
				createdAt: "2026-03-21T12:00:00.000Z",
				updatedAt: "2026-03-21T12:01:00.000Z",
			},
		];
		let state = reduce(
			createInitialCrawlControllerState(),
			{ type: "resumableSessionsLoading", requestId: 1 },
			{ type: "resumableSessionsLoaded", requestId: 1, sessions },
		);

		state = crawlControllerReducer(state, {
			type: "resumableSessionsFailed",
			requestId: 2,
			error: "Network error",
		}).state;

		expect(state.resumableSessions.error).toBeNull();

		state = reduce(
			state,
			{ type: "resumableSessionsLoading", requestId: 3 },
			{
				type: "resumableSessionsFailed",
				requestId: 3,
				error: "Network error",
			},
		);

		expect(state.resumableSessions.items).toHaveLength(1);
		expect(state.resumableSessions.error).toBe("Network error");
		expect(state.resumableSessions.isLoading).toBe(false);
	});

	test("resumable session loading ignores stale completions", () => {
		const first: ResumableSessionSummary[] = [
			{
				id: "old",
				target: "https://old.example",
				status: "interrupted",
				pagesScanned: 1,
				createdAt: "2026-03-21T12:00:00.000Z",
				updatedAt: "2026-03-21T12:01:00.000Z",
			},
		];
		const latest: ResumableSessionSummary[] = [
			{
				id: "latest",
				target: "https://latest.example",
				status: "paused",
				pagesScanned: 2,
				createdAt: "2026-03-21T12:02:00.000Z",
				updatedAt: "2026-03-21T12:03:00.000Z",
			},
		];
		const state = reduce(
			createInitialCrawlControllerState(),
			{ type: "resumableSessionsLoading", requestId: 1 },
			{ type: "resumableSessionsLoading", requestId: 2 },
			{ type: "resumableSessionsLoaded", requestId: 1, sessions: first },
			{ type: "resumableSessionsLoaded", requestId: 2, sessions: latest },
		);

		expect(state.resumableSessions.items.map((session) => session.id)).toEqual([
			"latest",
		]);
		expect(state.resumableSessions.isLoading).toBe(false);
	});

	test("local resumable session removal invalidates active refreshes", () => {
		const oldResponse: ResumableSessionSummary[] = [
			{
				id: "deleted",
				target: "https://deleted.example",
				status: "paused",
				pagesScanned: 1,
				createdAt: "2026-03-21T12:00:00.000Z",
				updatedAt: "2026-03-21T12:01:00.000Z",
			},
		];
		const state = reduce(
			createInitialCrawlControllerState(),
			{ type: "resumableSessionsLoading", requestId: 7 },
			{ type: "resumableSessionDeleted", sessionId: "deleted" },
			{ type: "resumableSessionsLoaded", requestId: 7, sessions: oldResponse },
		);

		expect(state.resumableSessions.items).toEqual([]);
		expect(state.resumableSessions.isLoading).toBe(false);
		expect(state.resumableSessions.requestId).toBeNull();
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

	test("normalizes impossible links plus saveMedia option state", () => {
		const initial = createInitialCrawlControllerState();
		const next = reduce(initial, {
			type: "crawlOptionsChanged",
			crawlOptions: {
				...initial.crawlOptions,
				crawlMethod: "links",
				saveMedia: true,
			},
		});

		expect(next.crawlOptions.crawlMethod).toBe("links");
		expect(next.crawlOptions.saveMedia).toBe(false);
	});
});

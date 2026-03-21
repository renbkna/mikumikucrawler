import { describe, expect, test } from "bun:test";
import type { CrawlEventEnvelope } from "../../../server/contracts/events.js";
import { UI_LIMITS } from "../../constants";
import {
	type CrawlControllerAction,
	type CrawlControllerState,
	crawlControllerReducer,
	createInitialCrawlControllerState,
} from "../crawlControllerState";

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
});

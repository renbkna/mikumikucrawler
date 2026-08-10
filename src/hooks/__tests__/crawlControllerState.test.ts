import { describe, expect, test } from "bun:test";
import type {
	CrawlCounters,
	CrawlEventEnvelope,
	CrawledPage,
	CrawlOptions,
	CrawlSummary,
} from "../../../shared/contracts/index.js";
import { UI_LIMITS } from "../../constants";
import {
	type CrawlControllerAction,
	type CrawlControllerState,
	canStartCommand,
	crawlControllerReducer,
	createInitialCrawlControllerState,
	getCrawlCommandAvailability,
} from "../crawlControllerState";
import { drainQueuedRefreshes, isStartOperationSettled } from "../useCrawlController";

const options: CrawlOptions = {
	target: "https://example.com/",
	crawlMethod: "full",
	crawlDepth: 2,
	crawlDelay: 100,
	maxPages: 10,
	maxPagesPerDomain: 0,
	maxConcurrentRequests: 2,
	retryLimit: 1,
	dynamic: false,
	respectRobots: true,
	contentOnly: false,
	saveMedia: false,
};

function counters(pagesScanned = 0): CrawlCounters {
	return {
		pagesScanned,
		successCount: pagesScanned,
		failureCount: 0,
		skippedCount: 0,
		linksFound: pagesScanned * 2,
		mediaFiles: 0,
		totalDataKb: pagesScanned * 4,
	};
}

function summary(overrides: Partial<CrawlSummary> = {}): CrawlSummary {
	return {
		id: "crawl-1",
		eventSequence: 0,
		target: options.target,
		status: "running",
		options,
		counters: counters(),
		createdAt: "2026-01-01T00:00:00.000Z",
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:01.000Z",
		completedAt: null,
		stopReason: null,
		resumable: false,
		...overrides,
	};
}

function page(id: number, title = `Page ${id}`): CrawledPage & { domain: string } {
	return {
		id,
		url: `https://example.com/${id}`,
		title,
		domain: "example.com",
		details: {},
	};
}

function event<TType extends CrawlEventEnvelope["type"]>(
	type: TType,
	payload: Extract<CrawlEventEnvelope, { type: TType }>["payload"],
	sequence = 1,
	crawlId = "crawl-1",
): Extract<CrawlEventEnvelope, { type: TType }> {
	return {
		type,
		crawlId,
		sequence,
		timestamp: "2026-01-01T00:00:02.000Z",
		payload,
	} as Extract<CrawlEventEnvelope, { type: TType }>;
}

function active(overrides: Partial<CrawlControllerState> = {}): CrawlControllerState {
	return {
		...createInitialCrawlControllerState(),
		crawlOptions: options,
		activeCrawlOptions: options,
		activeCrawlId: "crawl-1",
		runPhase: "running",
		...overrides,
	};
}

function reduce(state: CrawlControllerState, action: CrawlControllerAction) {
	return crawlControllerReducer(state, action);
}

describe("crawl controller state", () => {
	test("coalesces refresh requests received while a refresh is in flight", async () => {
		const firstRefresh = Promise.withResolvers<void>();
		const state = { queued: false };
		let calls = 0;
		const draining = drainQueuedRefreshes(state, async () => {
			calls += 1;
			if (calls === 1) await firstRefresh.promise;
		});

		await Promise.resolve();
		state.queued = true;
		state.queued = true;
		firstRefresh.resolve();
		await draining;

		expect(calls).toBe(2);
	});

	test("releases a start operation only after a definitive create outcome", () => {
		for (const status of [503, 507]) {
			expect(
				isStartOperationSettled(
					{ ok: false, error: "admission rejected", status },
					{ ok: false, error: "Crawl not found", status: 404 },
				),
			).toBe(true);
		}
		expect(
			isStartOperationSettled(
				{ ok: false, error: "invalid", status: 422 },
				{ ok: false, error: "recovery unavailable" },
			),
		).toBe(true);
		expect(
			isStartOperationSettled(
				{ ok: false, error: "network unavailable" },
				{ ok: false, error: "recovery unavailable" },
			),
		).toBe(false);
	});

	test("keeps editable options as the only target authority", () => {
		const resumed = {
			...options,
			target: "https://resume.example/",
			crawlMethod: "links" as const,
		};
		const next = reduce(createInitialCrawlControllerState(), {
			type: "crawlOptionsChanged",
			crawlOptions: resumed,
		}).state;
		expect(next.crawlOptions).toEqual({ ...resumed, saveMedia: false });
		expect(next).not.toHaveProperty("target");
	});

	test("allows only one command, except force-stop escalation", () => {
		expect(canStartCommand(active({ pendingCommand: "stop" }), "forceStop")).toBe(true);
		expect(canStartCommand(active({ pendingCommand: "start" }), "forceStop")).toBe(false);

		const started = reduce(active(), { type: "commandStarted", kind: "stop" }).state;
		expect(started).toMatchObject({ pendingCommand: "stop", runPhase: "pausing" });
		const escalated = reduce(started, { type: "commandStarted", kind: "forceStop" }).state;
		expect(escalated).toMatchObject({ pendingCommand: "forceStop", runPhase: "stopping" });
		expect(getCrawlCommandAvailability(escalated).canForceStop).toBe(false);
	});

	test("clears command identity on matching completion and reports matching failures", () => {
		const pending = active({ pendingCommand: "stop", runPhase: "pausing" });
		expect(reduce(pending, { type: "commandSucceeded", kind: "start" }).state).toBe(pending);

		const failed = reduce(pending, {
			type: "commandFailed",
			kind: "stop",
			error: "pause rejected",
		});
		expect(failed.state).toMatchObject({ pendingCommand: null, runPhase: "running" });
		expect(failed.effects).toEqual([{ type: "toast", level: "error", message: "pause rejected" }]);
	});

	test("uses durable state after an ambiguous force-stop failure", () => {
		const stopping = active({ pendingCommand: "forceStop", runPhase: "stopping" });
		const recovered = reduce(stopping, {
			type: "commandFailed",
			kind: "forceStop",
			error: "Only active crawls can be stopped",
			recoveredCrawl: summary({ status: "paused", resumable: true }),
		});

		expect(recovered.state).toMatchObject({ pendingCommand: null, runPhase: "paused" });
		expect(recovered.effects).toEqual([
			{ type: "toast", level: "error", message: "Only active crawls can be stopped" },
		]);
	});

	test("treats a durably recovered pause outcome as command success", () => {
		const recovered = reduce(active({ pendingCommand: "stop", runPhase: "pausing" }), {
			type: "commandFailed",
			kind: "stop",
			error: "request connection closed",
			recoveredCrawl: summary({ status: "paused", resumable: true }),
		});

		expect(recovered.state).toMatchObject({ pendingCommand: null, runPhase: "paused" });
		expect(recovered.effects).toEqual([]);
	});

	test("preserves the durable paused phase after the stop command resolves", () => {
		const paused = active({ pendingCommand: "stop", runPhase: "paused" });
		expect(reduce(paused, { type: "commandSucceeded", kind: "stop" }).state).toMatchObject({
			pendingCommand: null,
			runPhase: "paused",
		});
	});

	test("binds a newly accepted crawl and handles resume sequence separately", () => {
		const prior = active({ lastSequence: 9 });
		const started = reduce(prior, {
			type: "crawlAccepted",
			crawlId: "crawl-2",
			kind: "start",
		}).state;
		const resumed = reduce(prior, {
			type: "crawlAccepted",
			crawlId: "crawl-2",
			kind: "resume",
			crawlOptions: options,
		}).state;

		expect(started).toMatchObject({ activeCrawlId: "crawl-2", lastSequence: 0 });
		expect(resumed).toMatchObject({ activeCrawlId: "crawl-2", lastSequence: 9 });
	});

	test("accepts only newer events for the active, non-terminal crawl", () => {
		const state = active({ lastSequence: 2 });
		const wrongCrawl = reduce(state, {
			type: "sseEventReceived",
			envelope: event("crawl.log", { message: "wrong", level: "info" }, 3, "crawl-2"),
		}).state;
		const duplicate = reduce(state, {
			type: "sseEventReceived",
			envelope: event("crawl.log", { message: "duplicate", level: "info" }, 2),
		}).state;
		const accepted = reduce(state, {
			type: "sseEventReceived",
			envelope: event("crawl.log", { message: "accepted", level: "error" }, 3),
		}).state;

		expect(wrongCrawl).toBe(state);
		expect(duplicate).toBe(state);
		expect(accepted).toMatchObject({
			lastSequence: 3,
			logs: [{ id: 1, message: "accepted", level: "error" }],
		});
		expect(
			reduce(
				{ ...accepted, runPhase: "completed" },
				{
					type: "sseEventReceived",
					envelope: event("crawl.log", { message: "late", level: "info" }, 4),
				},
			).state,
		).toEqual({ ...accepted, runPhase: "completed" });
	});

	test("reconciles validated counter tuples monotonically and derives progress from queue telemetry", () => {
		const state = active({ stats: counters(5) });
		const older = reduce(state, {
			type: "sseEventReceived",
			envelope: event("crawl.progress", {
				counters: counters(4),
				queue: { activeRequests: 1, queueLength: 2, elapsedTime: 8, pagesPerSecond: 0.5 },
				stopReason: null,
			}),
		}).state;
		expect(older.stats).toEqual(counters(5));
		expect(older.queueStats?.elapsedTime).toBe(8);
		expect(older.progress).toBe(50);

		const newer = reduce(older, {
			type: "sseEventReceived",
			envelope: event(
				"crawl.progress",
				{
					counters: counters(6),
					queue: { activeRequests: 0, queueLength: 0, elapsedTime: 9, pagesPerSecond: 1 },
					stopReason: null,
				},
				2,
			),
		}).state;
		expect(newer.stats).toEqual(counters(6));
		expect(newer.progress).toBe(60);
	});

	test("merges durable recovery by page identity without downgrading live data", () => {
		const state = active({
			lastSequence: 2,
			crawledPages: [page(2, "Live title")],
			storedPageCount: 2,
		});
		const next = reduce(state, {
			type: "crawlRecoverySnapshotSynchronized",
			snapshot: {
				crawl: summary({ eventSequence: 3, counters: counters(2) }),
				pages: [page(2, "Durable summary"), page(1)],
				pageCount: 3,
			},
		}).state;

		expect(next.crawledPages.map(({ id, title }) => ({ id, title }))).toEqual([
			{ id: 2, title: "Live title" },
			{ id: 1, title: "Page 1" },
		]);
		expect(next.storedPageCount).toBe(3);
		expect(next.lastSequence).toBe(3);
	});

	test("accepts a newer durable terminal state after a local pause", () => {
		const next = reduce(active({ runPhase: "paused", lastSequence: 2 }), {
			type: "crawlSummarySynchronized",
			crawl: summary({
				status: "completed",
				eventSequence: 3,
				counters: counters(3),
				completedAt: "2026-01-01T00:00:03.000Z",
			}),
		}).state;

		expect(next).toMatchObject({
			runPhase: "completed",
			connectionState: "disconnected",
			lastSequence: 3,
			progress: 100,
			stats: counters(3),
		});
	});

	test.each([
		["crawl.completed", "completed", { counters: counters(3) }],
		["crawl.stopped", "stopped", { stopReason: "forced", counters: counters(3) }],
		["crawl.failed", "failed", { error: "broken", counters: counters(3) }],
	] as const)("settles %s authoritatively", (type, phase, payload) => {
		const transition = reduce(active({ pendingCommand: "stop" }), {
			type: "sseEventReceived",
			envelope: event(type, payload),
		});
		expect(transition.state).toMatchObject({
			runPhase: phase,
			connectionState: "disconnected",
			pendingCommand: null,
			progress: 100,
			stats: counters(3),
		});
		expect(transition.effects[0]?.type).toBe("toast");
	});

	test("settles pauses without forcing terminal progress", () => {
		const transition = reduce(active({ pendingCommand: "stop" }), {
			type: "sseEventReceived",
			envelope: event("crawl.paused", { stopReason: null, counters: counters(2) }),
		});
		expect(transition.state).toMatchObject({
			runPhase: "paused",
			connectionState: "disconnected",
			pendingCommand: null,
			stats: counters(2),
		});
	});

	test("bounds logs and emits the static-fallback hint once", () => {
		let state = active();
		let warningCount = 0;
		for (let index = 0; index <= UI_LIMITS.MAX_LOGS; index += 1) {
			const transition = reduce(state, {
				type: "logAppended",
				message: index < 2 ? `Falling back to static crawling ${index}` : `ordinary log ${index}`,
				level: "info",
			});
			state = transition.state;
			warningCount += transition.effects.filter(
				(effect) => effect.type === "toast" && effect.level === "warning",
			).length;
		}
		expect(state.logs).toHaveLength(UI_LIMITS.MAX_LOGS);
		expect(warningCount).toBe(1);
	});

	test("serializes resumable-session mutation and removes deleted state", () => {
		const session = {
			id: "paused-1",
			target: options.target,
			status: "paused" as const,
			pagesScanned: 2,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:01.000Z",
		};
		let state = reduce(createInitialCrawlControllerState(), {
			type: "resumableSessionsLoaded",
			sessions: [session],
		}).state;
		const loading = {
			...state,
			resumableSessions: { ...state.resumableSessions, isLoading: true },
		};
		const resuming = reduce(loading, {
			type: "resumableSessionResuming",
			sessionId: session.id,
		}).state;
		expect(resuming.resumableSessions.isLoading).toBe(false);
		state = reduce(loading, { type: "resumableSessionDeleting", sessionId: session.id }).state;
		expect(state.resumableSessions.isLoading).toBe(false);
		expect(reduce(state, { type: "resumableSessionResuming", sessionId: session.id }).state).toBe(
			state,
		);
		state = reduce(state, { type: "resumableSessionDeleted", sessionId: session.id }).state;
		expect(state.resumableSessions).toMatchObject({ items: [], deletingId: null });
	});

	test("active session deletion uses the live-state reset policy", () => {
		const sessionId = "crawl-1";
		const state = active({
			lastSequence: 8,
			progress: 70,
			stats: counters(7),
			queueStats: { activeRequests: 1, queueLength: 2, elapsedTime: 3, pagesPerSecond: 1 },
			crawledPages: [page(1)],
			storedPageCount: 1,
			logs: [{ id: 1, message: "running", level: "info" }],
			searchQuery: "needle",
			resumableSessions: {
				items: [
					{
						id: sessionId,
						target: options.target,
						status: "paused",
						pagesScanned: 7,
						createdAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:01.000Z",
					},
				],
				isLoading: false,
				error: null,
				deletingId: sessionId,
				resumingId: null,
			},
		});

		const deleted = reduce(state, { type: "resumableSessionDeleted", sessionId }).state;

		expect(deleted).toMatchObject({
			activeCrawlId: null,
			activeCrawlOptions: null,
			connectionState: "connected",
			runPhase: "idle",
			stats: counters(),
			queueStats: null,
			crawledPages: [],
			storedPageCount: 0,
			progress: 0,
			logs: [],
			searchQuery: "",
			lastSequence: 0,
			resumableSessions: { items: [], deletingId: null },
		});
	});
});

import type {
	ActiveCrawlStatus,
	CrawlCounters,
	CrawlEventEnvelope,
	CrawlEventMap,
	CrawlOptions,
	CrawlRecoverySnapshot,
	CrawlStatus,
	CrawlSummary,
	ResumableSessionSummary,
} from "../../shared/contracts/index.js";
import {
	createEmptyCrawlCounters,
	isActiveCrawlStatus,
	isResumableCrawlStatus,
	isTerminalCrawlStatus,
	normalizeCrawlOptions,
} from "../../shared/contracts/index.js";
import type { CrawledPage, QueueStats } from "../../shared/contracts/pageData.js";
import { TOAST_DEFAULTS, UI_LIMITS } from "../constants";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export type RunPhase = Exclude<CrawlStatus, "pending"> | "idle";

export type ActiveRunPhase = Exclude<ActiveCrawlStatus, "pending">;

export type CommandKind = "start" | "stop" | "forceStop" | "resume" | "refresh" | "delete";

export interface ResumableSessionsState {
	items: ResumableSessionSummary[];
	isLoading: boolean;
	error: string | null;
	deletingId: string | null;
	resumingId: string | null;
}

export type ControllerLog = CrawlEventMap["crawl.log"] & { id: number };

export interface CrawlControllerState {
	crawlOptions: CrawlOptions;
	activeCrawlOptions: CrawlOptions | null;
	activeCrawlId: string | null;
	connectionState: ConnectionState;
	runPhase: RunPhase;
	stats: CrawlCounters;
	queueStats: QueueStats | null;
	crawledPages: CrawledPage[];
	storedPageCount: number;
	progress: number;
	logs: ControllerLog[];
	searchQuery: string;
	resumableSessions: ResumableSessionsState;
	lastSequence: number;
	pendingCommand: CommandKind | null;
}

export interface CrawlCommandAvailability {
	canStart: boolean;
	canPause: boolean;
	canForceStop: boolean;
	isAttacking: boolean;
}

export type ControllerEffect = {
	type: "toast";
	level: "success" | "error" | "info" | "warning";
	message: string;
	timeout?: number;
};

export interface ControllerStateTransition {
	state: CrawlControllerState;
	effects: ControllerEffect[];
}

export const INITIAL_CRAWL_OPTIONS: CrawlOptions = {
	target: "",
	crawlMethod: "full",
	crawlDepth: 2,
	crawlDelay: 1000,
	maxPages: 50,
	maxPagesPerDomain: 0,
	maxConcurrentRequests: 5,
	retryLimit: 3,
	dynamic: true,
	respectRobots: true,
	contentOnly: false,
	saveMedia: false,
};

export function createInitialCrawlControllerState(): CrawlControllerState {
	return {
		crawlOptions: INITIAL_CRAWL_OPTIONS,
		activeCrawlOptions: null,
		activeCrawlId: null,
		connectionState: "connected",
		runPhase: "idle",
		stats: createEmptyCrawlCounters(),
		queueStats: null,
		crawledPages: [],
		storedPageCount: 0,
		progress: 0,
		logs: [],
		searchQuery: "",
		resumableSessions: {
			items: [],
			isLoading: false,
			error: null,
			deletingId: null,
			resumingId: null,
		},
		lastSequence: 0,
		pendingCommand: null,
	};
}

function reconcileMonotonicStats(current: CrawlCounters, counters: CrawlCounters): CrawlCounters {
	// Crawl counters are one validated tuple: pagesScanned equals the sum of its
	// outcome counters. Select the newer tuple as a unit instead of constructing
	// an invalid mixture from independently maximized fields.
	return counters.pagesScanned > current.pagesScanned ? counters : current;
}

function reconcileStoredPageCount(current: number, durableCount: number): number {
	return Math.max(current, durableCount);
}

function withoutEffects(state: CrawlControllerState): ControllerStateTransition {
	return { state, effects: [] };
}

function appendLog(
	state: CrawlControllerState,
	message: string,
	level: ControllerLog["level"],
): CrawlControllerState {
	return {
		...state,
		logs: [{ id: (state.logs[0]?.id ?? 0) + 1, message, level }, ...state.logs].slice(
			0,
			UI_LIMITS.MAX_LOGS,
		),
	};
}

export function isActiveRunPhase(runPhase: RunPhase): runPhase is ActiveRunPhase {
	return runPhase !== "idle" && isActiveCrawlStatus(runPhase);
}

export function isTerminalRunPhase(runPhase: RunPhase): boolean {
	return runPhase !== "idle" && isTerminalCrawlStatus(runPhase);
}

/** A locally requested pause or stop outranks non-settling evidence that the crawl is still active. */
function keepWindingDownPhase(current: RunPhase, next: RunPhase): RunPhase {
	return current === "pausing" || current === "stopping" ? current : next;
}

function synchronizeCrawlSummary(
	state: CrawlControllerState,
	crawl: CrawlRecoverySnapshot["crawl"],
): CrawlControllerState {
	if (state.activeCrawlId !== crawl.id) return state;
	if (isTerminalRunPhase(state.runPhase)) return state;
	if (crawl.eventSequence < state.lastSequence) return state;
	const snapshotSettled =
		isResumableCrawlStatus(crawl.status) || isTerminalCrawlStatus(crawl.status);

	const stats = snapshotSettled
		? crawl.counters
		: reconcileMonotonicStats(state.stats, crawl.counters);
	const runPhase = runPhaseFromCrawlStatus(crawl.status);
	return {
		...state,
		activeCrawlOptions: crawl.options,
		stats,
		progress: isTerminalCrawlStatus(crawl.status)
			? 100
			: computeProgress({ ...state, activeCrawlOptions: crawl.options }, stats, state.queueStats),
		runPhase: snapshotSettled ? runPhase : keepWindingDownPhase(state.runPhase, runPhase),
		connectionState: snapshotSettled ? "disconnected" : state.connectionState,
		pendingCommand: snapshotSettled ? null : state.pendingCommand,
		lastSequence: crawl.eventSequence,
	};
}

function runPhaseFromCrawlStatus(status: CrawlStatus): RunPhase {
	switch (status) {
		case "pending":
		case "starting":
			return "starting";
		case "running":
		case "pausing":
		case "paused":
		case "stopping":
		case "completed":
		case "stopped":
		case "failed":
		case "interrupted":
			return status;
		default:
			return assertNever(status);
	}
}

export function getCrawlCommandAvailability(
	state: Pick<CrawlControllerState, "runPhase" | "pendingCommand">,
): CrawlCommandAvailability {
	const commandPending = isAnyCommandPending(state);
	const canEscalateStop = canStartCommand(state, "forceStop");
	const forceStopPending = state.pendingCommand === "forceStop";

	return {
		canStart: !commandPending && !isActiveRunPhase(state.runPhase),
		isAttacking: isActiveRunPhase(state.runPhase),
		canPause: canRequestPause(state.runPhase) && !commandPending,
		canForceStop:
			!forceStopPending &&
			(!commandPending || canEscalateStop) &&
			isActiveRunPhase(state.runPhase) &&
			state.runPhase !== "stopping",
	};
}

export function canRequestPause(runPhase: RunPhase): boolean {
	return runPhase === "starting" || runPhase === "running";
}

export function isAnyCommandPending(state: Pick<CrawlControllerState, "pendingCommand">): boolean {
	return state.pendingCommand !== null;
}

export function canStartCommand(
	state: Pick<CrawlControllerState, "pendingCommand">,
	kind: CommandKind,
): boolean {
	return !isAnyCommandPending(state) || (kind === "forceStop" && state.pendingCommand === "stop");
}

function computeProgress(
	state: CrawlControllerState,
	nextStats: CrawlCounters,
	nextQueue: QueueStats | null,
): number {
	const queueSize = nextQueue?.queueLength ?? state.queueStats?.queueLength ?? 0;
	const activeSize = nextQueue?.activeRequests ?? state.queueStats?.activeRequests ?? 0;
	const scanned = nextStats.pagesScanned ?? 0;
	const totalWork = scanned + queueSize + activeSize;
	const effectiveTotal = Math.max(
		totalWork,
		(state.activeCrawlOptions ?? state.crawlOptions).maxPages,
		1,
	);
	return totalWork > 0 ? Math.min((scanned / effectiveTotal) * 100, 100) : 0;
}

type ResumableSessionsAction =
	| { type: "resumableSessionsLoading" }
	| { type: "resumableSessionsLoaded"; sessions: ResumableSessionSummary[] }
	| { type: "resumableSessionsFailed"; error: string }
	| { type: "resumableSessionDeleting"; sessionId: string }
	| { type: "resumableSessionResuming"; sessionId: string }
	| { type: "resumableSessionResumeFinished"; sessionId: string }
	| { type: "resumableSessionRemoved"; sessionId: string }
	| { type: "resumableSessionDeleteFailed"; sessionId: string; error: string };

export type CrawlControllerAction =
	| { type: "crawlOptionsChanged"; crawlOptions: CrawlOptions }
	| { type: "searchChanged"; searchQuery: string }
	| { type: "logsCleared" }
	| { type: "logAppended"; message: string; level: ControllerLog["level"] }
	| { type: "liveStateReset" }
	| { type: "crawlSummarySynchronized"; crawl: CrawlRecoverySnapshot["crawl"] }
	| { type: "crawlRecoverySnapshotSynchronized"; snapshot: CrawlRecoverySnapshot }
	| { type: "connectionChanged"; connectionState: ConnectionState }
	| { type: "commandStarted"; kind: CommandKind }
	| { type: "commandSucceeded"; kind: CommandKind }
	| { type: "commandFailed"; kind: CommandKind; error: string; recoveredCrawl?: CrawlSummary }
	| {
			type: "crawlAccepted";
			crawlId: string;
			kind: "start" | "resume";
			crawlOptions?: CrawlOptions;
	  }
	| { type: "sseEventReceived"; envelope: CrawlEventEnvelope }
	| { type: "resumableSessionDeleted"; sessionId: string }
	| ResumableSessionsAction;

function applyTerminalEvent(
	state: CrawlControllerState,
	envelope: Extract<
		CrawlEventEnvelope,
		{ type: "crawl.completed" | "crawl.stopped" | "crawl.failed" }
	>,
): ControllerStateTransition {
	const nextStats = envelope.payload.counters;
	const effects: ControllerEffect[] = [];
	const terminalPhaseByType = {
		"crawl.completed": "completed",
		"crawl.stopped": "stopped",
		"crawl.failed": "failed",
	} as const;

	if (envelope.type === "crawl.completed") {
		effects.push({
			type: "toast",
			level: "success",
			message: `Crawl completed! Scanned ${nextStats.pagesScanned} pages`,
			timeout: TOAST_DEFAULTS.LONG_TIMEOUT,
		});
	} else if (envelope.type === "crawl.stopped") {
		effects.push({
			type: "toast",
			level: "info",
			message: envelope.payload.stopReason || "Crawler stopped",
		});
	} else {
		effects.push({
			type: "toast",
			level: "error",
			message: envelope.payload.error || "Crawl failed",
		});
	}

	return {
		state: {
			...state,
			stats: nextStats,
			connectionState: "disconnected",
			runPhase: terminalPhaseByType[envelope.type],
			progress: 100,
			pendingCommand: null,
		},
		effects,
	};
}

function applyPausedEvent(
	state: CrawlControllerState,
	envelope: Extract<CrawlEventEnvelope, { type: "crawl.paused" }>,
): ControllerStateTransition {
	const effects: ControllerEffect[] =
		state.runPhase === "paused"
			? []
			: [
					{
						type: "toast",
						level: "info",
						message: envelope.payload.stopReason ?? "Crawl paused. Resume it from saved sessions.",
					},
				];

	return {
		state: {
			...state,
			stats: envelope.payload.counters,
			progress: computeProgress(state, envelope.payload.counters, state.queueStats),
			connectionState: "disconnected",
			runPhase: "paused",
			pendingCommand: null,
		},
		effects,
	};
}

function assertNever(value: never): never {
	throw new Error(`Unhandled value: ${String(value)}`);
}

function applySseEvent(
	state: CrawlControllerState,
	envelope: CrawlEventEnvelope,
): ControllerStateTransition {
	if (
		state.activeCrawlId !== envelope.crawlId ||
		isTerminalRunPhase(state.runPhase) ||
		envelope.sequence <= state.lastSequence
	) {
		return withoutEffects(state);
	}

	const nextStateBase: CrawlControllerState = {
		...state,
		lastSequence: envelope.sequence,
	};

	switch (envelope.type) {
		case "crawl.started": {
			const { target, resume, dynamicRendering } = envelope.payload;
			const staticFallback = state.activeCrawlOptions?.dynamic === true && !dynamicRendering;
			return {
				state: appendLog(
					{
						...nextStateBase,
						runPhase: keepWindingDownPhase(nextStateBase.runPhase, "running"),
					},
					resume
						? `[Resume] Crawl runtime resumed for ${target}`
						: `[Crawler] Crawl started for ${target}`,
					"info",
				),
				effects: staticFallback
					? [
							{
								type: "toast",
								level: "warning",
								message:
									"Tip: Try disabling JavaScript crawling in settings for better performance",
								timeout: TOAST_DEFAULTS.LONG_TIMEOUT,
							},
						]
					: [],
			};
		}
		case "crawl.log":
			return withoutEffects(
				appendLog(nextStateBase, envelope.payload.message, envelope.payload.level),
			);
		case "crawl.page": {
			const { pageCount, ...page } = envelope.payload;
			const crawledPages = mergeCrawledPages([page], nextStateBase.crawledPages);
			return withoutEffects({
				...nextStateBase,
				crawledPages,
				storedPageCount: reconcileStoredPageCount(nextStateBase.storedPageCount, pageCount),
			});
		}
		case "crawl.progress": {
			const nextQueue = envelope.payload.queue;
			const nextStats = reconcileMonotonicStats(nextStateBase.stats, envelope.payload.counters);

			return withoutEffects({
				...nextStateBase,
				queueStats: nextQueue,
				stats: nextStats,
				progress: computeProgress(nextStateBase, nextStats, nextQueue),
				runPhase: keepWindingDownPhase(nextStateBase.runPhase, "running"),
			});
		}
		case "crawl.completed":
		case "crawl.stopped":
		case "crawl.failed":
			return applyTerminalEvent(nextStateBase, envelope);
		case "crawl.paused":
			return applyPausedEvent(nextStateBase, envelope);
		default:
			return assertNever(envelope);
	}
}

function mergeCrawledPages(incoming: CrawledPage[], existing: CrawledPage[]): CrawledPage[] {
	const identities = new Set<number>();
	const pages: CrawledPage[] = [];
	for (const page of [...incoming, ...existing]) {
		if (identities.has(page.id)) continue;
		identities.add(page.id);
		pages.push(page);
	}
	return pages.sort((left, right) => right.id - left.id).slice(0, UI_LIMITS.MAX_PAGE_BUFFER);
}

function resetLiveState(state: CrawlControllerState): CrawlControllerState {
	return {
		...state,
		activeCrawlId: null,
		activeCrawlOptions: null,
		connectionState: "connected",
		runPhase: "idle",
		stats: createEmptyCrawlCounters(),
		queueStats: null,
		crawledPages: [],
		storedPageCount: 0,
		progress: 0,
		logs: [],
		searchQuery: "",
		lastSequence: 0,
	};
}

function removeResumableSession(
	sessions: ResumableSessionsState,
	sessionId: string,
): ResumableSessionsState {
	return {
		...sessions,
		items: sessions.items.filter((session) => session.id !== sessionId),
		deletingId: sessions.deletingId === sessionId ? null : sessions.deletingId,
		resumingId: sessions.resumingId === sessionId ? null : sessions.resumingId,
		isLoading: false,
	};
}

function reduceResumableSessions(
	sessions: ResumableSessionsState,
	action: ResumableSessionsAction,
): ResumableSessionsState {
	const mutationPending = sessions.deletingId !== null || sessions.resumingId !== null;
	switch (action.type) {
		case "resumableSessionsLoading":
			return { ...sessions, isLoading: true, error: null };
		case "resumableSessionsLoaded":
			return { ...sessions, items: action.sessions, isLoading: false, error: null };
		case "resumableSessionsFailed":
			return { ...sessions, isLoading: false, error: action.error };
		case "resumableSessionDeleting":
			if (mutationPending) return sessions;
			return { ...sessions, isLoading: false, deletingId: action.sessionId, error: null };
		case "resumableSessionResuming":
			if (mutationPending) return sessions;
			return { ...sessions, isLoading: false, resumingId: action.sessionId, error: null };
		case "resumableSessionResumeFinished":
			if (sessions.resumingId !== action.sessionId) return sessions;
			return { ...sessions, resumingId: null };
		case "resumableSessionRemoved":
			return removeResumableSession(sessions, action.sessionId);
		case "resumableSessionDeleteFailed":
			if (sessions.deletingId !== action.sessionId) return sessions;
			return { ...sessions, deletingId: null, error: action.error };
		default:
			return assertNever(action);
	}
}

function reduceState(
	state: CrawlControllerState,
	action: Exclude<CrawlControllerAction, { type: "sseEventReceived" | "commandFailed" }>,
): CrawlControllerState {
	switch (action.type) {
		case "crawlOptionsChanged":
			return { ...state, crawlOptions: normalizeCrawlOptions(action.crawlOptions) };
		case "searchChanged":
			return { ...state, searchQuery: action.searchQuery };
		case "logsCleared":
			return { ...state, logs: [] };
		case "logAppended":
			return appendLog(state, action.message, action.level);
		case "liveStateReset":
			return resetLiveState(state);
		case "crawlSummarySynchronized":
			return synchronizeCrawlSummary(state, action.crawl);
		case "crawlRecoverySnapshotSynchronized": {
			const { crawl, pages, pageCount } = action.snapshot;
			if (state.activeCrawlId !== crawl.id) return state;

			const synchronizedState = synchronizeCrawlSummary(state, crawl);

			// Durable snapshots contain summary projections. Existing live page
			// payloads carry richer fields for the same persisted page identity and
			// must not be downgraded when the snapshot fills gaps in live delivery.
			return {
				...synchronizedState,
				crawledPages: mergeCrawledPages(synchronizedState.crawledPages, pages),
				storedPageCount: reconcileStoredPageCount(synchronizedState.storedPageCount, pageCount),
			};
		}
		case "connectionChanged":
			return { ...state, connectionState: action.connectionState };
		case "commandStarted":
			if (!canStartCommand(state, action.kind)) return state;
			return {
				...state,
				pendingCommand: action.kind,
				runPhase:
					action.kind === "forceStop"
						? "stopping"
						: action.kind === "stop"
							? "pausing"
							: state.runPhase,
			};
		case "commandSucceeded":
			if (state.pendingCommand !== action.kind) return state;
			return {
				...state,
				pendingCommand: null,
				runPhase:
					(action.kind === "stop" || action.kind === "forceStop") &&
					state.activeCrawlId &&
					isActiveRunPhase(state.runPhase)
						? action.kind === "forceStop"
							? "stopping"
							: "pausing"
						: state.runPhase,
			};
		case "crawlAccepted":
			return {
				...state,
				activeCrawlId: action.crawlId,
				activeCrawlOptions: action.crawlOptions ?? state.crawlOptions,
				runPhase: "starting",
				connectionState: "connecting",
				lastSequence: action.kind === "resume" ? state.lastSequence : 0,
			};
		case "resumableSessionDeleted": {
			const nextState = state.activeCrawlId === action.sessionId ? resetLiveState(state) : state;
			return {
				...nextState,
				resumableSessions: removeResumableSession(nextState.resumableSessions, action.sessionId),
			};
		}
		case "resumableSessionsLoading":
		case "resumableSessionsLoaded":
		case "resumableSessionsFailed":
		case "resumableSessionDeleting":
		case "resumableSessionResuming":
		case "resumableSessionResumeFinished":
		case "resumableSessionRemoved":
		case "resumableSessionDeleteFailed": {
			const resumableSessions = reduceResumableSessions(state.resumableSessions, action);
			return resumableSessions === state.resumableSessions
				? state
				: { ...state, resumableSessions };
		}
		default:
			return assertNever(action);
	}
}

function applyCommandFailed(
	state: CrawlControllerState,
	action: Extract<CrawlControllerAction, { type: "commandFailed" }>,
): ControllerStateTransition {
	if (state.pendingCommand !== action.kind) return withoutEffects(state);
	const recoveredCrawl =
		action.recoveredCrawl?.id === state.activeCrawlId ? action.recoveredCrawl : undefined;
	const recoveredState = recoveredCrawl ? synchronizeCrawlSummary(state, recoveredCrawl) : state;
	const recoveredCommandSucceeded =
		recoveredCrawl !== undefined &&
		((action.kind === "stop" && !isActiveCrawlStatus(recoveredCrawl.status)) ||
			(action.kind === "forceStop" && isTerminalCrawlStatus(recoveredCrawl.status)));

	return {
		state: {
			...recoveredState,
			pendingCommand: null,
			runPhase:
				recoveredCrawl !== undefined
					? runPhaseFromCrawlStatus(recoveredCrawl.status)
					: (action.kind === "stop" || action.kind === "forceStop") &&
							state.activeCrawlId &&
							!isTerminalRunPhase(state.runPhase)
						? "running"
						: recoveredState.runPhase,
		},
		effects: recoveredCommandSucceeded
			? []
			: [{ type: "toast", level: "error", message: action.error }],
	};
}

export function crawlControllerReducer(
	state: CrawlControllerState,
	action: CrawlControllerAction,
): ControllerStateTransition {
	switch (action.type) {
		case "sseEventReceived":
			return applySseEvent(state, action.envelope);
		case "commandFailed":
			return applyCommandFailed(state, action);
		default:
			return withoutEffects(reduceState(state, action));
	}
}

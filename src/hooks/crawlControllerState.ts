import type {
	CrawlCounters,
	CrawlEventEnvelope,
	CrawlOptions,
	CrawlRecoverySnapshot,
	CrawlStatus,
	CrawlSummary,
	ResumableSessionSummary,
} from "../../shared/contracts/index.js";
import {
	createEmptyCrawlCounters,
	isResumableCrawlStatus,
	isTerminalCrawlStatus,
	normalizeCrawlOptions,
} from "../../shared/contracts/index.js";
import type { CrawledPage, QueueStats } from "../../shared/contracts/pageData.js";
import { TOAST_DEFAULTS, UI_LIMITS } from "../constants";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export type RunPhase = Exclude<CrawlStatus, "pending"> | "idle";

export type CommandKind = "start" | "stop" | "forceStop" | "resume" | "refresh" | "delete";

export interface ResumableSessionsState {
	items: ResumableSessionSummary[];
	isLoading: boolean;
	error: string | null;
	deletingId: string | null;
	resumingId: string | null;
}

export interface ControllerLog {
	id: number;
	message: string;
}

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
	hasShownStaticFallbackHint: boolean;
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
		hasShownStaticFallbackHint: false,
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

function appendLog(state: CrawlControllerState, message: string): ControllerStateTransition {
	const nextLogs = [{ id: (state.logs[0]?.id ?? 0) + 1, message }, ...state.logs].slice(
		0,
		UI_LIMITS.MAX_LOGS,
	);
	const effects: ControllerEffect[] = [];

	if (
		message.toLowerCase().includes("falling back to static crawling") &&
		!state.hasShownStaticFallbackHint
	) {
		effects.push({
			type: "toast",
			level: "warning",
			message: "Tip: Try disabling JavaScript crawling in settings for better performance",
			timeout: TOAST_DEFAULTS.LONG_TIMEOUT,
		});
	}

	return {
		state: {
			...state,
			logs: nextLogs,
			hasShownStaticFallbackHint:
				state.hasShownStaticFallbackHint ||
				message.toLowerCase().includes("falling back to static crawling"),
		},
		effects,
	};
}

export function isTerminalRunPhase(runPhase: RunPhase): boolean {
	return runPhase === "completed" || runPhase === "failed" || runPhase === "stopped";
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
		runPhase:
			!snapshotSettled && (state.runPhase === "pausing" || state.runPhase === "stopping")
				? state.runPhase
				: runPhase,
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
		canStart:
			!commandPending &&
			state.runPhase !== "starting" &&
			state.runPhase !== "running" &&
			state.runPhase !== "pausing" &&
			state.runPhase !== "stopping",
		isAttacking:
			state.runPhase === "starting" ||
			state.runPhase === "running" ||
			state.runPhase === "pausing" ||
			state.runPhase === "stopping",
		canPause: canRequestPause(state.runPhase) && !commandPending,
		canForceStop:
			!forceStopPending &&
			(!commandPending || canEscalateStop) &&
			(state.runPhase === "starting" ||
				state.runPhase === "running" ||
				state.runPhase === "pausing"),
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

export type CrawlControllerAction =
	| { type: "crawlOptionsChanged"; crawlOptions: CrawlOptions }
	| { type: "searchChanged"; searchQuery: string }
	| { type: "logsCleared" }
	| { type: "logAppended"; message: string }
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
	| { type: "resumableSessionsLoading" }
	| {
			type: "resumableSessionsLoaded";
			sessions: ResumableSessionSummary[];
	  }
	| {
			type: "resumableSessionsFailed";
			error: string;
	  }
	| {
			type: "resumableSessionDeleting";
			sessionId: string;
	  }
	| {
			type: "resumableSessionResuming";
			sessionId: string;
	  }
	| {
			type: "resumableSessionResumeFinished";
			sessionId: string;
	  }
	| {
			type: "resumableSessionDeleted";
			sessionId: string;
	  }
	| {
			type: "resumableSessionRemoved";
			sessionId: string;
	  }
	| {
			type: "resumableSessionDeleteFailed";
			sessionId: string;
			error: string;
	  };

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
	if (state.activeCrawlId !== envelope.crawlId) {
		return { state, effects: [] };
	}

	if (isTerminalRunPhase(state.runPhase)) {
		return { state, effects: [] };
	}

	if (envelope.sequence <= state.lastSequence) {
		return { state, effects: [] };
	}

	const nextStateBase: CrawlControllerState = {
		...state,
		lastSequence: envelope.sequence,
	};

	switch (envelope.type) {
		case "crawl.started": {
			const transition = appendLog(
				{
					...nextStateBase,
					runPhase:
						nextStateBase.runPhase === "stopping" || nextStateBase.runPhase === "pausing"
							? nextStateBase.runPhase
							: "running",
				},
				envelope.payload.resume
					? `[Resume] Crawl runtime resumed for ${envelope.payload.target}`
					: `[Crawler] Crawl started for ${envelope.payload.target}`,
			);
			return transition;
		}
		case "crawl.log":
			return appendLog(nextStateBase, envelope.payload.message);
		case "crawl.page": {
			const { pageCount, ...page } = envelope.payload;
			const crawledPages = mergeCrawledPages([page], nextStateBase.crawledPages);
			return {
				state: {
					...nextStateBase,
					crawledPages,
					storedPageCount: reconcileStoredPageCount(nextStateBase.storedPageCount, pageCount),
				},
				effects: [],
			};
		}
		case "crawl.progress": {
			const nextQueue = envelope.payload.queue;
			const nextStats = reconcileMonotonicStats(nextStateBase.stats, envelope.payload.counters);

			return {
				state: {
					...nextStateBase,
					queueStats: nextQueue,
					stats: nextStats,
					progress: computeProgress(nextStateBase, nextStats, nextQueue),
					runPhase:
						nextStateBase.runPhase === "stopping" || nextStateBase.runPhase === "pausing"
							? nextStateBase.runPhase
							: "running",
				},
				effects: [],
			};
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

export function crawlControllerReducer(
	state: CrawlControllerState,
	action: CrawlControllerAction,
): ControllerStateTransition {
	switch (action.type) {
		case "crawlOptionsChanged":
			return {
				state: {
					...state,
					crawlOptions: normalizeCrawlOptions(action.crawlOptions),
				},
				effects: [],
			};
		case "searchChanged":
			return {
				state: { ...state, searchQuery: action.searchQuery },
				effects: [],
			};
		case "logsCleared":
			return {
				state: { ...state, logs: [] },
				effects: [],
			};
		case "logAppended":
			return appendLog(state, action.message);
		case "liveStateReset":
			return {
				state: {
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
					hasShownStaticFallbackHint: false,
					searchQuery: "",
					lastSequence: 0,
				},
				effects: [],
			};
		case "crawlSummarySynchronized":
			return {
				state: synchronizeCrawlSummary(state, action.crawl),
				effects: [],
			};
		case "crawlRecoverySnapshotSynchronized": {
			const { crawl, pages, pageCount } = action.snapshot;
			if (state.activeCrawlId !== crawl.id) {
				return { state, effects: [] };
			}

			const synchronizedState = synchronizeCrawlSummary(state, crawl);

			// Durable snapshots contain summary projections. Existing live page
			// payloads carry richer fields for the same persisted page identity and
			// must not be downgraded when the snapshot fills replay gaps.
			const crawledPages = mergeCrawledPages(synchronizedState.crawledPages, pages);
			return {
				state: {
					...synchronizedState,
					crawledPages,
					storedPageCount: reconcileStoredPageCount(synchronizedState.storedPageCount, pageCount),
				},
				effects: [],
			};
		}
		case "connectionChanged":
			return {
				state: {
					...state,
					connectionState: action.connectionState,
				},
				effects: [],
			};
		case "commandStarted":
			if (!canStartCommand(state, action.kind)) {
				return { state, effects: [] };
			}
			return {
				state: {
					...state,
					pendingCommand: action.kind,
					runPhase:
						action.kind === "forceStop"
							? "stopping"
							: action.kind === "stop"
								? "pausing"
								: state.runPhase,
				},
				effects: [],
			};
		case "commandSucceeded":
			if (state.pendingCommand !== action.kind) {
				return { state, effects: [] };
			}

			return {
				state: {
					...state,
					pendingCommand: null,
					runPhase:
						(action.kind === "stop" || action.kind === "forceStop") &&
						state.activeCrawlId &&
						!isTerminalRunPhase(state.runPhase)
							? action.kind === "forceStop"
								? "stopping"
								: "pausing"
							: state.runPhase,
				},
				effects: [],
			};
		case "commandFailed": {
			if (state.pendingCommand !== action.kind) {
				return { state, effects: [] };
			}
			const recoveredCrawl =
				action.recoveredCrawl?.id === state.activeCrawlId ? action.recoveredCrawl : undefined;
			const recoveredState = recoveredCrawl
				? synchronizeCrawlSummary(state, recoveredCrawl)
				: state;

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
				effects: [
					{
						type: "toast",
						level: "error",
						message: action.error,
					},
				],
			};
		}
		case "crawlAccepted":
			return {
				state: {
					...state,
					activeCrawlId: action.crawlId,
					activeCrawlOptions: action.crawlOptions ?? state.crawlOptions,
					runPhase: "starting",
					connectionState: "connecting",
					lastSequence: action.kind === "resume" ? state.lastSequence : 0,
					pendingCommand: null,
				},
				effects: [],
			};
		case "sseEventReceived":
			return applySseEvent(state, action.envelope);
		case "resumableSessionsLoading":
			return {
				state: {
					...state,
					resumableSessions: {
						...state.resumableSessions,
						isLoading: true,
						error: null,
					},
				},
				effects: [],
			};
		case "resumableSessionsLoaded":
			return {
				state: {
					...state,
					resumableSessions: {
						items: action.sessions,
						isLoading: false,
						error: null,
						deletingId: state.resumableSessions.deletingId,
						resumingId: state.resumableSessions.resumingId,
					},
				},
				effects: [],
			};
		case "resumableSessionsFailed":
			return {
				state: {
					...state,
					resumableSessions: {
						...state.resumableSessions,
						isLoading: false,
						error: action.error,
					},
				},
				effects: [],
			};
		case "resumableSessionDeleting":
			if (state.resumableSessions.deletingId || state.resumableSessions.resumingId) {
				return { state, effects: [] };
			}

			return {
				state: {
					...state,
					resumableSessions: {
						...state.resumableSessions,
						isLoading: false,
						deletingId: action.sessionId,
						error: null,
					},
				},
				effects: [],
			};
		case "resumableSessionResuming":
			if (state.resumableSessions.deletingId || state.resumableSessions.resumingId) {
				return { state, effects: [] };
			}

			return {
				state: {
					...state,
					resumableSessions: {
						...state.resumableSessions,
						isLoading: false,
						resumingId: action.sessionId,
						error: null,
					},
				},
				effects: [],
			};
		case "resumableSessionResumeFinished":
			if (state.resumableSessions.resumingId !== action.sessionId) {
				return { state, effects: [] };
			}

			return {
				state: {
					...state,
					resumableSessions: {
						...state.resumableSessions,
						resumingId: null,
					},
				},
				effects: [],
			};
		case "resumableSessionDeleted": {
			const activeCrawlDeleted = state.activeCrawlId === action.sessionId;
			return {
				state: {
					...state,
					...(activeCrawlDeleted
						? {
								activeCrawlId: null,
								activeCrawlOptions: null,
								connectionState: "connected" as const,
								runPhase: "idle" as const,
								stats: createEmptyCrawlCounters(),
								queueStats: null,
								crawledPages: [],
								storedPageCount: 0,
								progress: 0,
								logs: [],
								hasShownStaticFallbackHint: false,
								searchQuery: "",
							}
						: {}),
					resumableSessions: {
						...state.resumableSessions,
						items: state.resumableSessions.items.filter(
							(session) => session.id !== action.sessionId,
						),
						deletingId:
							state.resumableSessions.deletingId === action.sessionId
								? null
								: state.resumableSessions.deletingId,
						resumingId:
							state.resumableSessions.resumingId === action.sessionId
								? null
								: state.resumableSessions.resumingId,
						isLoading: false,
					},
				},
				effects: [],
			};
		}
		case "resumableSessionRemoved":
			return {
				state: {
					...state,
					resumableSessions: {
						...state.resumableSessions,
						items: state.resumableSessions.items.filter(
							(session) => session.id !== action.sessionId,
						),
						deletingId:
							state.resumableSessions.deletingId === action.sessionId
								? null
								: state.resumableSessions.deletingId,
						resumingId:
							state.resumableSessions.resumingId === action.sessionId
								? null
								: state.resumableSessions.resumingId,
						isLoading: false,
					},
				},
				effects: [],
			};
		case "resumableSessionDeleteFailed":
			if (state.resumableSessions.deletingId !== action.sessionId) {
				return { state, effects: [] };
			}

			return {
				state: {
					...state,
					resumableSessions: {
						...state.resumableSessions,
						deletingId: null,
						error: action.error,
					},
				},
				effects: [],
			};
		default:
			return assertNever(action);
	}
}

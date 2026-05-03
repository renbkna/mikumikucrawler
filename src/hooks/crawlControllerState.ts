import type { CrawlEventEnvelope } from "../../shared/contracts/index.js";
import type { ResumableSessionSummary } from "../../shared/contracts/index.js";
import { CRAWLER_DEFAULTS, TOAST_DEFAULTS, UI_LIMITS } from "../constants";
import type { CrawlOptions } from "../../shared/contracts/index.js";
import type { CrawledPage, QueueStats, Stats } from "../../shared/types.js";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export type RunPhase =
	| "idle"
	| "starting"
	| "running"
	| "pausing"
	| "paused"
	| "stopping"
	| "completed"
	| "failed"
	| "stopped";

export interface CommandStatus {
	kind:
		| "none"
		| "start"
		| "stop"
		| "forceStop"
		| "resume"
		| "export"
		| "refresh"
		| "delete";
	status: "idle" | "pending" | "success" | "error";
	error: string | null;
}

export type CommandKind = CommandStatus["kind"];

export interface ResumableSessionsState {
	items: ResumableSessionSummary[];
	isLoading: boolean;
	error: string | null;
	deletingId: string | null;
	resumingId: string | null;
	requestId: number | null;
}

export interface CrawlControllerState {
	target: string;
	crawlOptions: CrawlOptions;
	activeCrawlOptions: CrawlOptions | null;
	activeCrawlId: string | null;
	connectionState: ConnectionState;
	runPhase: RunPhase;
	stats: Stats;
	queueStats: QueueStats | null;
	crawledPages: CrawledPage[];
	progress: number;
	logs: string[];
	hasShownStaticFallbackHint: boolean;
	filterText: string;
	resumableSessions: ResumableSessionsState;
	lastSequenceByCrawlId: Record<string, number>;
	lastCommand: CommandStatus;
}

export interface CrawlCommandAvailability {
	canStart: boolean;
	canPause: boolean;
	canForceStop: boolean;
	isAttacking: boolean;
}

export type ControllerEffect =
	| {
			type: "toast";
			level: "success" | "error" | "info" | "warning";
			message: string;
			timeout?: number;
	  }
	| { type: "none" };

export interface ControllerStateTransition {
	state: CrawlControllerState;
	effects: ControllerEffect[];
}

function createIdleCommandStatus(): CommandStatus {
	return {
		kind: "none",
		status: "idle",
		error: null,
	};
}

function createCommandStatus(
	kind: CommandKind,
	status: CommandStatus["status"],
	error: string | null = null,
): CommandStatus {
	return {
		kind,
		status,
		error,
	};
}

const INITIAL_STATS: Stats = {
	pagesScanned: 0,
	linksFound: 0,
	totalData: 0,
	mediaFiles: 0,
	successCount: 0,
	failureCount: 0,
	skippedCount: 0,
};

export const INITIAL_CRAWL_OPTIONS: CrawlOptions = {
	target: "",
	crawlMethod: CRAWLER_DEFAULTS.CRAWL_METHOD,
	crawlDepth: CRAWLER_DEFAULTS.CRAWL_DEPTH,
	crawlDelay: CRAWLER_DEFAULTS.CRAWL_DELAY,
	maxPages: CRAWLER_DEFAULTS.MAX_PAGES,
	maxPagesPerDomain: CRAWLER_DEFAULTS.MAX_PAGES_PER_DOMAIN,
	maxConcurrentRequests: CRAWLER_DEFAULTS.MAX_CONCURRENT_REQUESTS,
	retryLimit: CRAWLER_DEFAULTS.RETRY_LIMIT,
	dynamic: CRAWLER_DEFAULTS.DYNAMIC,
	respectRobots: CRAWLER_DEFAULTS.RESPECT_ROBOTS,
	contentOnly: CRAWLER_DEFAULTS.CONTENT_ONLY,
	saveMedia: CRAWLER_DEFAULTS.SAVE_MEDIA,
};

function normalizeCrawlOptions(options: CrawlOptions): CrawlOptions {
	if (options.crawlMethod !== "links" || !options.saveMedia) {
		return options;
	}

	return { ...options, saveMedia: false };
}

export function createInitialCrawlControllerState(): CrawlControllerState {
	return {
		target: "",
		crawlOptions: INITIAL_CRAWL_OPTIONS,
		activeCrawlOptions: null,
		activeCrawlId: null,
		connectionState: "connected",
		runPhase: "idle",
		stats: INITIAL_STATS,
		queueStats: null,
		crawledPages: [],
		progress: 0,
		logs: [],
		hasShownStaticFallbackHint: false,
		filterText: "",
		resumableSessions: {
			items: [],
			isLoading: false,
			error: null,
			deletingId: null,
			resumingId: null,
			requestId: null,
		},
		lastSequenceByCrawlId: {},
		lastCommand: createIdleCommandStatus(),
	};
}

function toElapsedTime(totalSeconds: number) {
	return {
		hours: Math.floor(totalSeconds / 3600),
		minutes: Math.floor((totalSeconds % 3600) / 60),
		seconds: totalSeconds % 60,
	};
}

function buildStats(
	counters: {
		pagesScanned: number;
		successCount: number;
		failureCount: number;
		skippedCount: number;
		linksFound: number;
		mediaFiles: number;
		totalDataKb: number;
	},
	extras?: {
		elapsedSeconds?: number;
		pagesPerSecond?: number;
	},
): Stats {
	const successRate = counters.pagesScanned
		? `${((counters.successCount / counters.pagesScanned) * 100).toFixed(1)}%`
		: "0%";

	return {
		pagesScanned: counters.pagesScanned,
		linksFound: counters.linksFound,
		totalData: counters.totalDataKb,
		mediaFiles: counters.mediaFiles,
		successCount: counters.successCount,
		failureCount: counters.failureCount,
		skippedCount: counters.skippedCount,
		elapsedTime:
			extras?.elapsedSeconds !== undefined
				? toElapsedTime(extras.elapsedSeconds)
				: undefined,
		pagesPerSecond:
			extras?.pagesPerSecond !== undefined
				? extras.pagesPerSecond.toFixed(2)
				: undefined,
		successRate,
	};
}

function appendLog(
	state: CrawlControllerState,
	message: string,
): ControllerStateTransition {
	const nextLogs = [message, ...state.logs].slice(0, UI_LIMITS.MAX_LOGS);
	const effects: ControllerEffect[] = [];

	if (
		message.toLowerCase().includes("falling back to static crawling") &&
		!state.hasShownStaticFallbackHint
	) {
		effects.push({
			type: "toast",
			level: "warning",
			message:
				"Tip: Try disabling JavaScript crawling in settings for better performance",
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

function isTerminalRunPhase(runPhase: RunPhase): boolean {
	return (
		runPhase === "paused" ||
		runPhase === "completed" ||
		runPhase === "failed" ||
		runPhase === "stopped"
	);
}

export function getCrawlCommandAvailability(
	state: Pick<CrawlControllerState, "runPhase" | "lastCommand">,
): CrawlCommandAvailability {
	const commandPending = isAnyCommandPending(state);
	const canEscalateStop = canStartCommand(state, "forceStop");
	const forceStopPending =
		state.lastCommand.kind === "forceStop" &&
		state.lastCommand.status === "pending";

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
		canPause: state.runPhase === "running" && !commandPending,
		canForceStop:
			!forceStopPending &&
			(!commandPending || canEscalateStop) &&
			(state.runPhase === "starting" ||
				state.runPhase === "running" ||
				state.runPhase === "pausing"),
	};
}

export function isAnyCommandPending(
	state: Pick<CrawlControllerState, "lastCommand">,
): boolean {
	return state.lastCommand.status === "pending";
}

export function canStartCommand(
	state: Pick<CrawlControllerState, "lastCommand">,
	kind: CommandKind,
): boolean {
	return (
		!isAnyCommandPending(state) ||
		(kind === "forceStop" && state.lastCommand.kind === "stop")
	);
}

function computeProgress(
	state: CrawlControllerState,
	nextStats: Stats,
	nextQueue: QueueStats | null,
): number {
	const queueSize =
		nextQueue?.queueLength ?? state.queueStats?.queueLength ?? 0;
	const activeSize =
		nextQueue?.activeRequests ?? state.queueStats?.activeRequests ?? 0;
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
	| { type: "targetChanged"; target: string }
	| { type: "crawlOptionsChanged"; crawlOptions: CrawlOptions }
	| { type: "filterChanged"; filterText: string }
	| { type: "logsCleared" }
	| { type: "logAppended"; message: string }
	| { type: "liveStateReset" }
	| { type: "connectionChanged"; connectionState: ConnectionState }
	| { type: "commandStarted"; kind: CommandKind }
	| { type: "commandSucceeded"; kind: CommandKind }
	| { type: "commandFailed"; kind: CommandKind; error: string }
	| {
			type: "crawlAccepted";
			crawlId: string;
			kind: "start" | "resume";
			crawlOptions?: CrawlOptions;
	  }
	| { type: "sseEventReceived"; envelope: CrawlEventEnvelope }
	| {
			type: "resumableSessionsLoading";
			requestId: number;
	  }
	| {
			type: "resumableSessionsLoaded";
			requestId: number;
			sessions: ResumableSessionSummary[];
	  }
	| {
			type: "resumableSessionsFailed";
			requestId: number;
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
	const nextStats = buildStats(envelope.payload.counters);
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
			lastCommand: createIdleCommandStatus(),
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
						message:
							envelope.payload.stopReason ??
							"Crawl paused. Resume it from saved sessions.",
					},
				];

	return {
		state: {
			...state,
			stats: buildStats(envelope.payload.counters),
			progress: computeProgress(
				state,
				buildStats(envelope.payload.counters),
				state.queueStats,
			),
			connectionState: "disconnected",
			runPhase: "paused",
			lastCommand: createIdleCommandStatus(),
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

	const lastSequence = state.lastSequenceByCrawlId[envelope.crawlId] ?? 0;
	if (envelope.sequence <= lastSequence) {
		return { state, effects: [] };
	}

	const nextStateBase: CrawlControllerState = {
		...state,
		lastSequenceByCrawlId: {
			...state.lastSequenceByCrawlId,
			[envelope.crawlId]: envelope.sequence,
		},
	};

	switch (envelope.type) {
		case "crawl.started": {
			const transition = appendLog(
				{
					...nextStateBase,
					runPhase:
						nextStateBase.runPhase === "stopping" ||
						nextStateBase.runPhase === "pausing"
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
		case "crawl.page":
			return {
				state: {
					...nextStateBase,
					crawledPages: [envelope.payload, ...nextStateBase.crawledPages].slice(
						0,
						UI_LIMITS.MAX_PAGE_BUFFER,
					),
				},
				effects: [],
			};
		case "crawl.progress": {
			const nextQueue = envelope.payload.queue;
			const nextStats = buildStats(envelope.payload.counters, {
				elapsedSeconds: envelope.payload.elapsedSeconds,
				pagesPerSecond: envelope.payload.pagesPerSecond,
			});

			return {
				state: {
					...nextStateBase,
					queueStats: nextQueue,
					stats: nextStats,
					progress: computeProgress(nextStateBase, nextStats, nextQueue),
					runPhase:
						nextStateBase.runPhase === "stopping" ||
						nextStateBase.runPhase === "pausing"
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

export function crawlControllerReducer(
	state: CrawlControllerState,
	action: CrawlControllerAction,
): ControllerStateTransition {
	switch (action.type) {
		case "targetChanged":
			return {
				state: {
					...state,
					target: action.target,
					crawlOptions: { ...state.crawlOptions, target: action.target },
				},
				effects: [],
			};
		case "crawlOptionsChanged":
			return {
				state: {
					...state,
					crawlOptions: normalizeCrawlOptions(action.crawlOptions),
				},
				effects: [],
			};
		case "filterChanged":
			return {
				state: { ...state, filterText: action.filterText },
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
					stats: INITIAL_STATS,
					queueStats: null,
					crawledPages: [],
					progress: 0,
					logs: [],
					hasShownStaticFallbackHint: false,
					filterText: "",
				},
				effects: [],
			};
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
					lastCommand: createCommandStatus(action.kind, "pending"),
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
			if (
				state.lastCommand.kind !== action.kind ||
				state.lastCommand.status !== "pending"
			) {
				return { state, effects: [] };
			}

			return {
				state: {
					...state,
					lastCommand: createCommandStatus(action.kind, "success"),
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
		case "commandFailed":
			if (
				state.lastCommand.kind !== action.kind ||
				state.lastCommand.status !== "pending"
			) {
				return { state, effects: [] };
			}

			return {
				state: {
					...state,
					lastCommand: createCommandStatus(action.kind, "error", action.error),
					runPhase:
						(action.kind === "stop" || action.kind === "forceStop") &&
						state.activeCrawlId &&
						!isTerminalRunPhase(state.runPhase)
							? "running"
							: state.runPhase,
				},
				effects: [
					{
						type: "toast",
						level: "error",
						message: action.error,
					},
				],
			};
		case "crawlAccepted":
			return {
				state: {
					...state,
					activeCrawlId: action.crawlId,
					activeCrawlOptions: action.crawlOptions ?? state.crawlOptions,
					runPhase: "starting",
					connectionState: "connecting",
					lastCommand: createCommandStatus(action.kind, "success"),
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
						requestId: action.requestId,
					},
				},
				effects: [],
			};
		case "resumableSessionsLoaded":
			if (state.resumableSessions.requestId !== action.requestId) {
				return { state, effects: [] };
			}

			return {
				state: {
					...state,
					resumableSessions: {
						items: action.sessions,
						isLoading: false,
						error: null,
						deletingId: state.resumableSessions.deletingId,
						resumingId: state.resumableSessions.resumingId,
						requestId: null,
					},
				},
				effects: [],
			};
		case "resumableSessionsFailed":
			if (state.resumableSessions.requestId !== action.requestId) {
				return { state, effects: [] };
			}

			return {
				state: {
					...state,
					resumableSessions: {
						...state.resumableSessions,
						isLoading: false,
						error: action.error,
						requestId: null,
					},
				},
				effects: [],
			};
		case "resumableSessionDeleting":
			if (
				state.resumableSessions.deletingId ||
				state.resumableSessions.resumingId
			) {
				return { state, effects: [] };
			}

			return {
				state: {
					...state,
					resumableSessions: {
						...state.resumableSessions,
						deletingId: action.sessionId,
						error: null,
					},
				},
				effects: [],
			};
		case "resumableSessionResuming":
			if (
				state.resumableSessions.deletingId ||
				state.resumableSessions.resumingId
			) {
				return { state, effects: [] };
			}

			return {
				state: {
					...state,
					resumableSessions: {
						...state.resumableSessions,
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
								stats: INITIAL_STATS,
								queueStats: null,
								crawledPages: [],
								progress: 0,
								logs: [],
								hasShownStaticFallbackHint: false,
								filterText: "",
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
						requestId: null,
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
						requestId: null,
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

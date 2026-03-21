import type { CrawlEventEnvelope } from "../../server/contracts/events.js";
import type { InterruptedSessionSummary } from "../api/crawls";
import { CRAWLER_DEFAULTS, TOAST_DEFAULTS, UI_LIMITS } from "../constants";
import type { CrawledPage, CrawlOptions, QueueStats, Stats } from "../types";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export type RunPhase =
	| "idle"
	| "starting"
	| "running"
	| "stopping"
	| "completed"
	| "failed"
	| "stopped";

export interface CommandStatus {
	kind: "none" | "start" | "stop" | "resume" | "export" | "refresh" | "delete";
	status: "idle" | "pending" | "success" | "error";
	error: string | null;
}

export type CommandKind = CommandStatus["kind"];

export interface InterruptedSessionsState {
	items: InterruptedSessionSummary[];
	isLoading: boolean;
	error: string | null;
	deletingId: string | null;
}

export interface CrawlControllerState {
	target: string;
	crawlOptions: CrawlOptions;
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
	interruptedSessions: InterruptedSessionsState;
	lastSequenceByCrawlId: Record<string, number>;
	lastCommand: CommandStatus;
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

export function createInitialCrawlControllerState(): CrawlControllerState {
	return {
		target: "",
		crawlOptions: INITIAL_CRAWL_OPTIONS,
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
		interruptedSessions: {
			items: [],
			isLoading: false,
			error: null,
			deletingId: null,
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
	const effectiveTotal = Math.max(totalWork, state.crawlOptions.maxPages, 1);
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
	| { type: "crawlAccepted"; crawlId: string; kind: "start" | "resume" }
	| { type: "sseEventReceived"; envelope: CrawlEventEnvelope }
	| {
			type: "interruptedSessionsLoading";
	  }
	| {
			type: "interruptedSessionsLoaded";
			sessions: InterruptedSessionSummary[];
	  }
	| {
			type: "interruptedSessionsFailed";
			error: string;
	  }
	| {
			type: "interruptedSessionDeleting";
			sessionId: string;
	  }
	| {
			type: "interruptedSessionDeleted";
			sessionId: string;
	  }
	| {
			type: "interruptedSessionDeleteFailed";
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
			runPhase:
				envelope.type === "crawl.completed"
					? "completed"
					: envelope.type === "crawl.stopped"
						? "stopped"
						: "failed",
			progress: 100,
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
					runPhase: "running",
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
						nextStateBase.runPhase === "stopping" ? "stopping" : "running",
				},
				effects: [],
			};
		}
		case "crawl.completed":
		case "crawl.stopped":
		case "crawl.failed":
			return applyTerminalEvent(nextStateBase, envelope);
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
					crawlOptions: action.crawlOptions,
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
			return {
				state: {
					...state,
					lastCommand: createCommandStatus(action.kind, "pending"),
					runPhase:
						action.kind === "start" || action.kind === "resume"
							? "starting"
							: action.kind === "stop"
								? "stopping"
								: state.runPhase,
				},
				effects: [],
			};
		case "commandSucceeded":
			return {
				state: {
					...state,
					lastCommand: createCommandStatus(action.kind, "success"),
					runPhase:
						action.kind === "stop" && state.activeCrawlId
							? "stopping"
							: state.runPhase,
				},
				effects: [],
			};
		case "commandFailed":
			return {
				state: {
					...state,
					lastCommand: createCommandStatus(action.kind, "error", action.error),
					runPhase:
						action.kind === "start" || action.kind === "resume"
							? "idle"
							: action.kind === "stop" && state.activeCrawlId
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
					runPhase: "starting",
					connectionState: "connecting",
					lastCommand: createCommandStatus(action.kind, "success"),
				},
				effects: [],
			};
		case "sseEventReceived":
			return applySseEvent(state, action.envelope);
		case "interruptedSessionsLoading":
			return {
				state: {
					...state,
					interruptedSessions: {
						...state.interruptedSessions,
						isLoading: true,
						error: null,
					},
				},
				effects: [],
			};
		case "interruptedSessionsLoaded":
			return {
				state: {
					...state,
					interruptedSessions: {
						items: action.sessions,
						isLoading: false,
						error: null,
						deletingId: null,
					},
				},
				effects: [],
			};
		case "interruptedSessionsFailed":
			return {
				state: {
					...state,
					interruptedSessions: {
						...state.interruptedSessions,
						isLoading: false,
						error: action.error,
					},
				},
				effects: [],
			};
		case "interruptedSessionDeleting":
			return {
				state: {
					...state,
					interruptedSessions: {
						...state.interruptedSessions,
						deletingId: action.sessionId,
						error: null,
					},
				},
				effects: [],
			};
		case "interruptedSessionDeleted":
			return {
				state: {
					...state,
					interruptedSessions: {
						...state.interruptedSessions,
						items: state.interruptedSessions.items.filter(
							(session) => session.id !== action.sessionId,
						),
						deletingId: null,
					},
				},
				effects: [],
			};
		case "interruptedSessionDeleteFailed":
			return {
				state: {
					...state,
					interruptedSessions: {
						...state.interruptedSessions,
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

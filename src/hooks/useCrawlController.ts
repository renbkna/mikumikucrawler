import {
	startTransition,
	useCallback,
	useEffect,
	useEffectEvent,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	CrawlSummary,
	ResumableSessionSummary,
} from "../../shared/contracts/index.js";
import {
	isSettledCrawlEventType,
	type CrawlEventEnvelope,
} from "../../shared/contracts/index.js";
import type { CrawlExportFormat } from "../../shared/contracts/index.js";
import type { ApiResult } from "../api/result";
import {
	createCrawl,
	deleteCrawl,
	exportCrawl,
	listResumableCrawls,
	resumeCrawl as resumeCrawlRequest,
	stopCrawl as stopCrawlRequest,
	subscribeToCrawlEvents,
} from "../api/crawls";
import { validatePublicHttpUrl } from "../../shared/url";
import type { Toast } from "../types";
import {
	type CrawlControllerAction,
	type CommandKind,
	type CrawlControllerState,
	canStartCommand,
	crawlControllerReducer,
	createInitialCrawlControllerState,
	getCrawlCommandAvailability,
} from "./crawlControllerState";

interface UseCrawlControllerOptions {
	addToast: (type: Toast["type"], message: string, timeout?: number) => void;
}

/**
 * Resume returns the persisted crawl record from the backend.
 * The controller must hydrate both target and options from that record so the
 * visible form reflects the settings the runtime is actually using.
 */
export function getResumeHydrationActions(
	crawl: Pick<CrawlSummary, "target" | "options">,
): CrawlControllerAction[] {
	return [
		{ type: "crawlOptionsChanged", crawlOptions: crawl.options },
		{ type: "targetChanged", target: crawl.target },
	];
}

function formatControllerError(error: unknown): string {
	return error instanceof Error ? error.message : "Request failed";
}

export function shouldSettleActiveSubscription(
	activeSubscriptionCrawlId: string | null,
	envelope: CrawlEventEnvelope,
): boolean {
	return (
		activeSubscriptionCrawlId === envelope.crawlId &&
		isSettledCrawlEventType(envelope.type)
	);
}

function useControllerState({ addToast }: UseCrawlControllerOptions) {
	const [state, setState] = useState<CrawlControllerState>(
		createInitialCrawlControllerState,
	);
	const stateRef = useRef(state);

	useEffect(() => {
		stateRef.current = state;
	}, [state]);

	const dispatch = useCallback(
		(action: CrawlControllerAction) => {
			const transition = crawlControllerReducer(stateRef.current, action);
			stateRef.current = transition.state;
			setState(transition.state);
			for (const effect of transition.effects) {
				if (effect.type === "toast") {
					addToast(effect.level, effect.message, effect.timeout);
				}
			}
		},
		[addToast],
	);

	return { state, stateRef, dispatch };
}

export function useCrawlController({ addToast }: UseCrawlControllerOptions) {
	const { state, stateRef, dispatch } = useControllerState({ addToast });
	const subscriptionRef = useRef<ReturnType<
		typeof subscribeToCrawlEvents
	> | null>(null);
	const activeSubscriptionCrawlIdRef = useRef<string | null>(null);
	const resumableRefreshRequestIdRef = useRef(0);

	const executeCommand = useCallback(
		async <T>(
			kind: CommandKind,
			request: () => Promise<ApiResult<T>>,
			onSuccess?: (data: T) => Promise<void> | void,
		) => {
			if (!canStartCommand(stateRef.current, kind)) {
				const message = "Another command is already running";
				addToast("warning", message);
				return { ok: false, error: message };
			}
			dispatch({ type: "commandStarted", kind });
			let result: ApiResult<T>;
			try {
				result = await request();
			} catch (error) {
				const message = formatControllerError(error);
				dispatch({ type: "commandFailed", kind, error: message });
				return { ok: false, error: message };
			}

			if (!result.ok) {
				dispatch({ type: "commandFailed", kind, error: result.error });
				return result;
			}

			try {
				await onSuccess?.(result.data);
			} catch (error) {
				const message = formatControllerError(error);
				dispatch({ type: "commandFailed", kind, error: message });
				return { ok: false, error: message };
			}

			dispatch({ type: "commandSucceeded", kind });
			return result;
		},
		[addToast, dispatch, stateRef],
	);

	const closeSubscription = useEffectEvent((crawlId?: string) => {
		if (
			crawlId !== undefined &&
			activeSubscriptionCrawlIdRef.current !== crawlId
		) {
			return;
		}

		subscriptionRef.current?.close();
		subscriptionRef.current = null;
		activeSubscriptionCrawlIdRef.current = null;
	});

	const applyEnvelope = useEffectEvent((envelope: CrawlEventEnvelope) => {
		startTransition(() => {
			dispatch({ type: "sseEventReceived", envelope });
		});

		if (
			shouldSettleActiveSubscription(
				activeSubscriptionCrawlIdRef.current,
				envelope,
			)
		) {
			closeSubscription(envelope.crawlId);
			void refreshResumableSessions(false);
		}
	});

	const connectToEvents = useEffectEvent((crawlId: string) => {
		closeSubscription();
		dispatch({ type: "connectionChanged", connectionState: "connecting" });
		activeSubscriptionCrawlIdRef.current = crawlId;
		subscriptionRef.current = subscribeToCrawlEvents(crawlId, {
			onOpen: () =>
				dispatch({ type: "connectionChanged", connectionState: "connected" }),
			onError: () =>
				dispatch({
					type: "connectionChanged",
					connectionState: "disconnected",
				}),
			onEvent: applyEnvelope,
		});
	});

	const refreshResumableSessions = useCallback(
		async (trackCommand = true) => {
			if (stateRef.current.resumableSessions.resumingId) {
				return;
			}
			if (trackCommand && !canStartCommand(stateRef.current, "refresh")) {
				addToast("warning", "Another command is already running");
				return;
			}
			const requestId = (resumableRefreshRequestIdRef.current += 1);
			if (trackCommand) {
				dispatch({ type: "commandStarted", kind: "refresh" });
			}
			dispatch({ type: "resumableSessionsLoading", requestId });
			let result: ApiResult<ResumableSessionSummary[]>;
			try {
				result = await listResumableCrawls();
			} catch (error) {
				result = { ok: false, error: formatControllerError(error) };
			}

			if (!result.ok) {
				dispatch({
					type: "resumableSessionsFailed",
					requestId,
					error: result.error,
				});
				if (trackCommand) {
					dispatch({
						type: "commandFailed",
						kind: "refresh",
						error: result.error,
					});
				}
				return;
			}

			dispatch({
				type: "resumableSessionsLoaded",
				requestId,
				sessions: result.data,
			});
			if (trackCommand) {
				dispatch({ type: "commandSucceeded", kind: "refresh" });
			}
		},
		[addToast, dispatch, stateRef],
	);

	const refreshResumableSessionsWithCommand = useCallback(
		() => refreshResumableSessions(true),
		[refreshResumableSessions],
	);

	useEffect(() => {
		void refreshResumableSessions(false);
	}, [refreshResumableSessions]);

	useEffect(() => {
		return () => {
			closeSubscription();
		};
	}, []);

	const handleTargetChange = useCallback(
		(nextTarget: string) => {
			dispatch({ type: "targetChanged", target: nextTarget });
		},
		[dispatch],
	);

	const setCrawlOptions = useCallback(
		(
			next:
				| typeof state.crawlOptions
				| ((previous: typeof state.crawlOptions) => typeof state.crawlOptions),
		) => {
			const nextValue =
				typeof next === "function" ? next(state.crawlOptions) : next;
			dispatch({ type: "crawlOptionsChanged", crawlOptions: nextValue });
		},
		[dispatch, state.crawlOptions],
	);

	const startCrawl = useCallback(
		async (isQuick = false) => {
			if (!state.target.trim()) {
				addToast("error", "Please enter a target URL!");
				return false;
			}
			if (!canStartCommand(stateRef.current, "start")) {
				addToast("warning", "Another command is already running");
				return false;
			}

			const validationResult = validatePublicHttpUrl(state.target);
			if ("error" in validationResult) {
				addToast("error", validationResult.error);
				return false;
			}

			const normalizedTarget = validationResult.url;
			if (normalizedTarget !== state.target) {
				dispatch({ type: "targetChanged", target: normalizedTarget });
			}

			dispatch({ type: "commandStarted", kind: "start" });

			if (isQuick) {
				addToast("info", "Lightning Strike! Skipping animation...");
			}

			let result: ApiResult<CrawlSummary>;
			try {
				result = await createCrawl({
					...state.crawlOptions,
					target: normalizedTarget,
				});
			} catch (error) {
				result = { ok: false, error: formatControllerError(error) };
			}

			if (!result.ok) {
				dispatch({ type: "commandFailed", kind: "start", error: result.error });
				return false;
			}

			dispatch({ type: "liveStateReset" });
			dispatch({
				type: "crawlAccepted",
				crawlId: result.data.id,
				kind: "start",
				crawlOptions: result.data.options,
			});
			dispatch({
				type: "logAppended",
				message: "Initiating Miku Beam Sequence...",
			});
			connectToEvents(result.data.id);
			return true;
		},
		[addToast, dispatch, state.crawlOptions, state.target, stateRef],
	);

	const pauseCrawl = useCallback(async () => {
		if (!state.activeCrawlId || state.runPhase !== "running") return;
		const crawlId = state.activeCrawlId;

		await executeCommand("stop", () => stopCrawlRequest(crawlId, "pause"));
	}, [executeCommand, state.activeCrawlId, state.runPhase]);

	const forceStopCrawl = useCallback(async () => {
		if (
			!state.activeCrawlId ||
			(state.lastCommand.kind === "forceStop" &&
				state.lastCommand.status === "pending")
		) {
			return;
		}
		const crawlId = state.activeCrawlId;

		await executeCommand("forceStop", () => stopCrawlRequest(crawlId, "force"));
	}, [
		executeCommand,
		state.activeCrawlId,
		state.lastCommand.kind,
		state.lastCommand.status,
	]);

	const resumeCrawl = useCallback(
		async (sessionId: string, sessionTarget: string) => {
			if (
				stateRef.current.resumableSessions.deletingId ||
				stateRef.current.resumableSessions.resumingId ||
				!canStartCommand(stateRef.current, "resume")
			) {
				if (!canStartCommand(stateRef.current, "resume")) {
					addToast("warning", "Another command is already running");
				}
				return false;
			}
			dispatch({ type: "resumableSessionResuming", sessionId });
			dispatch({ type: "commandStarted", kind: "resume" });

			let result: ApiResult<CrawlSummary>;
			try {
				result = await resumeCrawlRequest(sessionId);
			} catch (error) {
				result = { ok: false, error: formatControllerError(error) };
			}

			if (!result.ok) {
				dispatch({
					type: "commandFailed",
					kind: "resume",
					error: result.error,
				});
				dispatch({ type: "resumableSessionResumeFinished", sessionId });
				return false;
			}

			dispatch({ type: "liveStateReset" });
			dispatch({ type: "targetChanged", target: sessionTarget });
			for (const action of getResumeHydrationActions(result.data)) {
				dispatch(action);
			}
			dispatch({
				type: "crawlAccepted",
				crawlId: result.data.id,
				kind: "resume",
				crawlOptions: result.data.options,
			});
			dispatch({
				type: "resumableSessionRemoved",
				sessionId,
			});
			addToast("info", "Resuming saved crawl...");
			connectToEvents(result.data.id);
			return true;
		},
		[addToast, dispatch, stateRef],
	);

	const exportCurrentCrawl = useCallback(
		async (format: string) => {
			if (!state.activeCrawlId) {
				addToast("warning", "No crawl selected for export");
				return;
			}
			if (format !== "json" && format !== "csv") {
				addToast("error", "Unsupported export format");
				return;
			}
			const crawlId = state.activeCrawlId;

			await executeCommand(
				"export",
				() => exportCrawl(crawlId, format as CrawlExportFormat),
				({ blob, filename }) => {
					const url = URL.createObjectURL(blob);
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = filename;
					document.body.appendChild(anchor);
					anchor.click();
					setTimeout(() => {
						anchor.remove();
						URL.revokeObjectURL(url);
					}, 100);

					addToast(
						"success",
						`Data exported successfully as ${format.toUpperCase()}`,
					);
				},
			);
		},
		[addToast, executeCommand, state.activeCrawlId],
	);

	const deleteResumableSession = useCallback(
		async (sessionId: string) => {
			if (
				stateRef.current.resumableSessions.deletingId ||
				stateRef.current.resumableSessions.resumingId ||
				!canStartCommand(stateRef.current, "delete")
			) {
				if (!canStartCommand(stateRef.current, "delete")) {
					addToast("warning", "Another command is already running");
				}
				return false;
			}

			dispatch({ type: "resumableSessionDeleting", sessionId });
			const result = await executeCommand("delete", () =>
				deleteCrawl(sessionId),
			);
			if (!result.ok) {
				dispatch({
					type: "resumableSessionDeleteFailed",
					sessionId,
					error: result.error,
				});
				return false;
			}

			dispatch({ type: "resumableSessionDeleted", sessionId });
			return true;
		},
		[addToast, dispatch, executeCommand, stateRef],
	);

	const displayedPages = useMemo(() => {
		if (!state.filterText.trim()) {
			return state.crawledPages;
		}

		const loweredFilter = state.filterText.toLowerCase();
		return state.crawledPages.filter(
			(page) =>
				page.url.toLowerCase().includes(loweredFilter) ||
				page.title?.toLowerCase().includes(loweredFilter) ||
				page.description?.toLowerCase().includes(loweredFilter),
		);
	}, [state.crawledPages, state.filterText]);

	const availability = getCrawlCommandAvailability(state);

	return {
		target: state.target,
		crawlOptions: state.crawlOptions,
		setCrawlOptions,
		handleTargetChange,
		stats: state.stats,
		queueStats: state.queueStats,
		crawledPages: state.crawledPages,
		progress: state.progress,
		logs: state.logs,
		clearLogs: () => dispatch({ type: "logsCleared" }),
		filterText: state.filterText,
		setFilterText: (filterText: string) =>
			dispatch({ type: "filterChanged", filterText }),
		displayedPages,
		clearFilter: () => dispatch({ type: "filterChanged", filterText: "" }),
		isAttacking: availability.isAttacking,
		canStart: availability.canStart,
		canForceStop: availability.canForceStop,
		canPause: availability.canPause,
		connectionState: state.connectionState,
		resumableSessions: state.resumableSessions.items,
		resumableSessionsLoading: state.resumableSessions.isLoading,
		resumableSessionsError: state.resumableSessions.error,
		deletingResumableSessionId: state.resumableSessions.deletingId,
		resumingResumableSessionId: state.resumableSessions.resumingId,
		refreshResumableSessions: refreshResumableSessionsWithCommand,
		deleteResumableSession,
		startCrawl,
		pauseCrawl,
		forceStopCrawl,
		resumeCrawl,
		exportCrawl: exportCurrentCrawl,
	};
}

export type UseCrawlControllerReturn = ReturnType<typeof useCrawlController>;

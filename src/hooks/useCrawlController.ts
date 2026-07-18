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
	CrawlExportFormat,
	CrawledPage,
	CrawlRecoverySnapshot,
	CrawlSummary,
	ResumableSessionSummary,
} from "../../shared/contracts/index.js";
import {
	type CrawlEventEnvelope,
	isResumableCrawlStatus,
	isSettledCrawlEventType,
	isTerminalCrawlStatus,
} from "../../shared/contracts/index.js";
import { validatePublicHttpUrl } from "../../shared/url";
import {
	createCrawl,
	deleteCrawl,
	exportCrawl,
	getCrawlRecoverySnapshot,
	listResumableCrawls,
	resumeCrawl as resumeCrawlRequest,
	stopCrawl as stopCrawlRequest,
	subscribeToCrawlEvents,
} from "../api/crawls";
import type { ApiResult } from "../api/result";
import { searchStoredPages } from "../api/search";
import type { Toast } from "../types";
import {
	type CommandKind,
	type CrawlControllerAction,
	type CrawlControllerState,
	canRequestPause,
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
	crawl: Pick<CrawlSummary, "options">,
): CrawlControllerAction[] {
	return [
		{ type: "crawlOptionsChanged", crawlOptions: crawl.options },
		{ type: "targetChanged", target: crawl.options.target },
	];
}

function formatControllerError(error: unknown): string {
	return error instanceof Error ? error.message : "Request failed";
}

export function shouldSettleActiveSubscription(
	activeSubscriptionCrawlId: string | null,
	envelope: CrawlEventEnvelope,
): boolean {
	return activeSubscriptionCrawlId === envelope.crawlId && isSettledCrawlEventType(envelope.type);
}

function useControllerState({ addToast }: UseCrawlControllerOptions) {
	const [state, setState] = useState<CrawlControllerState>(createInitialCrawlControllerState);
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
	const subscriptionRef = useRef<ReturnType<typeof subscribeToCrawlEvents> | null>(null);
	const activeSubscriptionCrawlIdRef = useRef<string | null>(null);
	const resumableRefreshRequestIdRef = useRef(0);
	const pageSearchRequestIdRef = useRef(0);
	const durableSyncRequestIdRef = useRef(0);
	const durableSyncAbortRef = useRef<AbortController | null>(null);
	const durableSyncErrorCrawlIdRef = useRef<string | null>(null);
	const [pageSearch, setPageSearch] = useState<{
		pages: CrawledPage[];
		count: number;
		isLoading: boolean;
		error: string | null;
	}>({
		pages: [],
		count: 0,
		isLoading: false,
		error: null,
	});

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
		if (crawlId !== undefined && activeSubscriptionCrawlIdRef.current !== crawlId) {
			return;
		}

		subscriptionRef.current?.close();
		subscriptionRef.current = null;
		activeSubscriptionCrawlIdRef.current = null;
	});

	const cancelDurableSync = useEffectEvent(() => {
		durableSyncRequestIdRef.current += 1;
		durableSyncAbortRef.current?.abort();
		durableSyncAbortRef.current = null;
	});

	const synchronizeDurableSnapshot = useEffectEvent(async (crawlId: string) => {
		const requestId = durableSyncRequestIdRef.current + 1;
		durableSyncRequestIdRef.current = requestId;
		durableSyncAbortRef.current?.abort();
		const controller = new AbortController();
		durableSyncAbortRef.current = controller;

		try {
			const snapshotResult = await getCrawlRecoverySnapshot(crawlId, controller.signal);
			if (!snapshotResult.ok) {
				throw new Error(snapshotResult.error);
			}
			if (
				controller.signal.aborted ||
				durableSyncRequestIdRef.current !== requestId ||
				stateRef.current.activeCrawlId !== crawlId
			) {
				return;
			}

			dispatch({
				type: "crawlRecoverySnapshotSynchronized",
				snapshot: snapshotResult.data,
			});

			if (
				isResumableCrawlStatus(snapshotResult.data.crawl.status) ||
				isTerminalCrawlStatus(snapshotResult.data.crawl.status)
			) {
				closeSubscription(crawlId);
			}
			durableSyncErrorCrawlIdRef.current = null;
		} catch (error) {
			if (
				controller.signal.aborted ||
				durableSyncRequestIdRef.current !== requestId ||
				stateRef.current.activeCrawlId !== crawlId
			) {
				return;
			}

			if (durableSyncErrorCrawlIdRef.current !== crawlId) {
				durableSyncErrorCrawlIdRef.current = crawlId;
				addToast(
					"warning",
					`Live connection recovered, but durable state refresh failed: ${formatControllerError(error)}`,
				);
			}
		} finally {
			if (durableSyncRequestIdRef.current === requestId) {
				durableSyncAbortRef.current = null;
			}
		}
	});

	const applyEnvelope = useEffectEvent((envelope: CrawlEventEnvelope) => {
		startTransition(() => {
			dispatch({ type: "sseEventReceived", envelope });
		});

		if (shouldSettleActiveSubscription(activeSubscriptionCrawlIdRef.current, envelope)) {
			closeSubscription(envelope.crawlId);
			void refreshResumableSessions(false);
		}
	});

	const connectToEvents = useEffectEvent((crawlId: string) => {
		closeSubscription();
		cancelDurableSync();
		durableSyncErrorCrawlIdRef.current = null;
		dispatch({ type: "connectionChanged", connectionState: "connecting" });
		activeSubscriptionCrawlIdRef.current = crawlId;
		subscriptionRef.current = subscribeToCrawlEvents(crawlId, {
			onOpen: () => {
				if (activeSubscriptionCrawlIdRef.current !== crawlId) return;
				dispatch({ type: "connectionChanged", connectionState: "connected" });
				void synchronizeDurableSnapshot(crawlId);
			},
			onError: () => {
				if (activeSubscriptionCrawlIdRef.current !== crawlId) return;
				dispatch({
					type: "connectionChanged",
					connectionState: "disconnected",
				});
			},
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
			const requestId = resumableRefreshRequestIdRef.current + 1;
			resumableRefreshRequestIdRef.current = requestId;
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
			cancelDurableSync();
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
			const nextValue = typeof next === "function" ? next(state.crawlOptions) : next;
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

			const validationResult = validatePublicHttpUrl(state.target, {
				allowLocalhost: import.meta.env.DEV,
			});
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
		if (!state.activeCrawlId || !canRequestPause(state.runPhase)) return;
		const crawlId = state.activeCrawlId;

		await executeCommand("stop", () => stopCrawlRequest(crawlId, "pause"));
	}, [executeCommand, state.activeCrawlId, state.runPhase]);

	const forceStopCrawl = useCallback(async () => {
		if (
			!state.activeCrawlId ||
			(state.lastCommand.kind === "forceStop" && state.lastCommand.status === "pending")
		) {
			return;
		}
		const crawlId = state.activeCrawlId;

		await executeCommand("forceStop", () => stopCrawlRequest(crawlId, "force"));
	}, [executeCommand, state.activeCrawlId, state.lastCommand.kind, state.lastCommand.status]);

	const resumeCrawl = useCallback(
		async (sessionId: string) => {
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

			let result: ApiResult<CrawlRecoverySnapshot>;
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
			for (const action of getResumeHydrationActions(result.data.crawl)) {
				dispatch(action);
			}
			dispatch({
				type: "crawlAccepted",
				crawlId: result.data.crawl.id,
				kind: "resume",
				crawlOptions: result.data.crawl.options,
			});
			dispatch({
				type: "crawlRecoverySnapshotSynchronized",
				snapshot: result.data,
			});
			dispatch({
				type: "resumableSessionRemoved",
				sessionId,
			});
			addToast("info", "Resuming saved crawl...");
			connectToEvents(result.data.crawl.id);
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

					addToast("success", `Data exported successfully as ${format.toUpperCase()}`);
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
			const result = await executeCommand("delete", () => deleteCrawl(sessionId));
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

	useEffect(() => {
		const query = state.searchQuery.trim();
		const crawlId = state.activeCrawlId;
		const requestId = pageSearchRequestIdRef.current + 1;
		pageSearchRequestIdRef.current = requestId;

		if (!query || !crawlId) {
			setPageSearch({ pages: [], count: 0, isLoading: false, error: null });
			return;
		}

		const controller = new AbortController();
		setPageSearch({ pages: [], count: 0, isLoading: true, error: null });

		void searchStoredPages(crawlId, query, controller.signal)
			.then((result) => {
				if (controller.signal.aborted || pageSearchRequestIdRef.current !== requestId) {
					return;
				}

				if (!result.ok) {
					setPageSearch({ pages: [], count: 0, isLoading: false, error: result.error });
					return;
				}

				setPageSearch({
					pages: result.data.pages,
					count: result.data.count,
					isLoading: false,
					error: null,
				});
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted || pageSearchRequestIdRef.current !== requestId) {
					return;
				}

				setPageSearch({
					pages: [],
					count: 0,
					isLoading: false,
					error: formatControllerError(error),
				});
			});

		return () => controller.abort();
	}, [state.activeCrawlId, state.searchQuery]);

	const displayedPages = useMemo(
		() => (state.searchQuery.trim() ? pageSearch.pages : state.crawledPages),
		[pageSearch.pages, state.crawledPages, state.searchQuery],
	);
	const clearLogs = useCallback(() => dispatch({ type: "logsCleared" }), [dispatch]);
	const setSearchQuery = useCallback(
		(searchQuery: string) => dispatch({ type: "searchChanged", searchQuery }),
		[dispatch],
	);
	const clearSearch = useCallback(
		() => dispatch({ type: "searchChanged", searchQuery: "" }),
		[dispatch],
	);

	const availability = getCrawlCommandAvailability(state);

	return {
		target: state.target,
		crawlOptions: state.crawlOptions,
		setCrawlOptions,
		handleTargetChange,
		stats: state.stats,
		queueStats: state.queueStats,
		crawledPages: state.crawledPages,
		storedPageCount: state.storedPageCount,
		progress: state.progress,
		logs: state.logs,
		clearLogs,
		searchQuery: state.searchQuery,
		setSearchQuery,
		searchResultCount: pageSearch.count,
		isSearchingPages: pageSearch.isLoading,
		pageSearchError: pageSearch.error,
		displayedPages,
		clearSearch,
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

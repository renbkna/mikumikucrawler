import { startTransition, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type {
	CrawlExportFormat,
	CrawledPage,
	CrawlRecoverySnapshot,
	CrawlSummary,
	ResumableSessionSummary,
	StopCrawlMode,
} from "../../shared/contracts/index.js";
import {
	type CrawlEventEnvelope,
	crawlOptionsEqual,
	isActiveCrawlStatus,
	isResumableCrawlStatus,
	isSettledCrawlEventType,
	isTerminalCrawlStatus,
} from "../../shared/contracts/index.js";
import { normalizeCanonicalHttpUrl } from "../../shared/url";
import {
	createCrawl,
	deleteCrawl,
	downloadCrawlExport,
	getCrawlRecoverySnapshot,
	listResumableCrawls,
	resumeCrawl as resumeCrawlRequest,
	stopCrawl as stopCrawlRequest,
	subscribeToCrawlEvents,
} from "../api/crawls";
import type { ApiFailure, ApiResult } from "../api/result";
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
	isTerminalRunPhase,
} from "./crawlControllerState";

const DURABLE_RECOVERY_RETRY_MS = 5_000;

interface UseCrawlControllerOptions {
	addToast: (type: Toast["type"], message: string, timeout?: number) => void;
}

export async function drainQueuedRefreshes<T>(
	state: { queued: boolean },
	refresh: () => Promise<T>,
): Promise<T> {
	state.queued = false;
	let result = await refresh();
	while (state.queued) {
		state.queued = false;
		result = await refresh();
	}
	return result;
}

function formatControllerError(error: unknown): string {
	return error instanceof Error ? error.message : "Request failed";
}

export function isStartOperationSettled(
	createFailure: ApiFailure,
	recovery: ApiResult<unknown> | null,
): boolean {
	return (
		createFailure.status === 422 ||
		recovery?.ok === true ||
		(typeof createFailure.status === "number" && recovery?.status === 404)
	);
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
	const resumableRefreshAbortRef = useRef<AbortController | null>(null);
	const resumableRefreshQueueRef = useRef({ queued: false });
	const durableSyncAbortRef = useRef<AbortController | null>(null);
	const durableSyncErrorCrawlIdRef = useRef<string | null>(null);
	const startOperationRef = useRef<{
		crawlId: string;
		options: typeof state.crawlOptions;
	} | null>(null);
	const controllerLifetimeRef = useRef<AbortController | null>(null);
	const commandAbortRef = useRef<AbortController | null>(null);
	const getControllerLifetimeSignal = useCallback(() => {
		return (
			controllerLifetimeRef.current?.signal ??
			AbortSignal.abort(new Error("Crawl controller is not active"))
		);
	}, []);
	useEffect(() => {
		const controller = new AbortController();
		controllerLifetimeRef.current = controller;
		return () => {
			controller.abort();
		};
	}, []);
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
			request: (signal: AbortSignal) => Promise<ApiResult<T>>,
			onSuccess?: (data: T) => Promise<void> | void,
			reconcileFailure?: (
				failure: ApiFailure,
				signal: AbortSignal,
			) => Promise<CrawlSummary | undefined>,
		) => {
			if (!canStartCommand(stateRef.current, kind)) {
				const message = "Another command is already running";
				addToast("warning", message);
				return { ok: false, error: message };
			}
			if (kind === "forceStop") {
				commandAbortRef.current?.abort();
			}
			const commandController = new AbortController();
			commandAbortRef.current = commandController;
			const signal = AbortSignal.any([getControllerLifetimeSignal(), commandController.signal]);
			const abortedResult = (): ApiResult<T> => ({
				ok: false,
				error: formatControllerError(signal.reason),
			});
			if (signal.aborted) return abortedResult();
			dispatch({ type: "commandStarted", kind });
			let result: ApiResult<T>;
			try {
				result = await request(signal);
			} catch (error) {
				if (signal.aborted) return abortedResult();
				const message = formatControllerError(error);
				dispatch({ type: "commandFailed", kind, error: message });
				return { ok: false, error: message };
			} finally {
				if (commandAbortRef.current === commandController) {
					commandAbortRef.current = null;
				}
			}
			if (signal.aborted) return abortedResult();

			if (!result.ok) {
				let recoveredCrawl: CrawlSummary | undefined;
				try {
					recoveredCrawl = await reconcileFailure?.(result, signal);
				} catch {
					// The original command failure remains authoritative when recovery also fails.
				}
				if (signal.aborted) return abortedResult();
				dispatch({
					type: "commandFailed",
					kind,
					error: result.error,
					...(recoveredCrawl ? { recoveredCrawl } : {}),
				});
				return result;
			}

			try {
				await onSuccess?.(result.data);
			} catch (error) {
				if (signal.aborted) return abortedResult();
				const message = formatControllerError(error);
				dispatch({ type: "commandFailed", kind, error: message });
				return { ok: false, error: message };
			}
			if (signal.aborted) return abortedResult();

			dispatch({ type: "commandSucceeded", kind });
			return result;
		},
		[addToast, dispatch, getControllerLifetimeSignal, stateRef],
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
		durableSyncAbortRef.current?.abort();
		durableSyncAbortRef.current = null;
	});

	const cancelResumableRefresh = useEffectEvent(() => {
		resumableRefreshQueueRef.current.queued = false;
		resumableRefreshAbortRef.current?.abort();
		resumableRefreshAbortRef.current = null;
	});

	const synchronizeDurableSnapshot = useEffectEvent(async (crawlId: string) => {
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
				durableSyncAbortRef.current !== controller ||
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
				void refreshResumableSessions(false);
			}
			durableSyncErrorCrawlIdRef.current = null;
		} catch (error) {
			if (
				controller.signal.aborted ||
				durableSyncAbortRef.current !== controller ||
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
			if (durableSyncAbortRef.current === controller) {
				durableSyncAbortRef.current = null;
			}
		}
	});

	const applyEnvelope = useEffectEvent((envelope: CrawlEventEnvelope) => {
		const hasSequenceGap = envelope.sequence > stateRef.current.lastSequence + 1;
		startTransition(() => {
			dispatch({ type: "sseEventReceived", envelope });
		});
		if (hasSequenceGap && stateRef.current.activeCrawlId === envelope.crawlId) {
			void synchronizeDurableSnapshot(envelope.crawlId);
		}

		if (
			activeSubscriptionCrawlIdRef.current === envelope.crawlId &&
			isSettledCrawlEventType(envelope.type)
		) {
			closeSubscription(envelope.crawlId);
		}
		if (isSettledCrawlEventType(envelope.type)) {
			void refreshResumableSessions(false);
		}
	});

	const connectToEvents = useEffectEvent((crawlId: string) => {
		const lifetimeSignal = getControllerLifetimeSignal();
		if (lifetimeSignal.aborted) return;
		closeSubscription();
		cancelDurableSync();
		durableSyncErrorCrawlIdRef.current = null;
		dispatch({ type: "connectionChanged", connectionState: "connecting" });
		activeSubscriptionCrawlIdRef.current = crawlId;
		subscriptionRef.current = subscribeToCrawlEvents(crawlId, {
			onOpen: () => {
				if (lifetimeSignal.aborted || activeSubscriptionCrawlIdRef.current !== crawlId) return;
				dispatch({ type: "connectionChanged", connectionState: "connected" });
			},
			onError: () => {
				if (lifetimeSignal.aborted || activeSubscriptionCrawlIdRef.current !== crawlId) return;
				dispatch({
					type: "connectionChanged",
					connectionState: "disconnected",
				});
				void synchronizeDurableSnapshot(crawlId);
			},
			onInvalidEvent: () => {
				if (lifetimeSignal.aborted || activeSubscriptionCrawlIdRef.current !== crawlId) return;
				void synchronizeDurableSnapshot(crawlId);
			},
			onEvent: (event) => {
				if (!lifetimeSignal.aborted) applyEnvelope(event);
			},
		});
		void synchronizeDurableSnapshot(crawlId);
	});

	const refreshResumableSessions = useCallback(
		async (trackCommand = true) => {
			if (stateRef.current.resumableSessions.resumingId) {
				return;
			}
			if (resumableRefreshAbortRef.current) {
				resumableRefreshQueueRef.current.queued = true;
				return;
			}
			if (trackCommand && !canStartCommand(stateRef.current, "refresh")) {
				addToast("warning", "Another command is already running");
				return;
			}
			if (trackCommand) {
				dispatch({ type: "commandStarted", kind: "refresh" });
			}
			const result = await drainQueuedRefreshes(resumableRefreshQueueRef.current, async () => {
				const controller = new AbortController();
				resumableRefreshAbortRef.current = controller;
				const signal = AbortSignal.any([getControllerLifetimeSignal(), controller.signal]);
				dispatch({ type: "resumableSessionsLoading" });
				let currentResult: ApiResult<ResumableSessionSummary[]>;
				try {
					currentResult = await listResumableCrawls(signal);
				} catch (error) {
					currentResult = { ok: false, error: formatControllerError(error) };
				}

				if (signal.aborted || resumableRefreshAbortRef.current !== controller) return null;
				if (currentResult.ok) {
					dispatch({ type: "resumableSessionsLoaded", sessions: currentResult.data });
				} else {
					dispatch({ type: "resumableSessionsFailed", error: currentResult.error });
				}
				if (resumableRefreshAbortRef.current === controller) {
					resumableRefreshAbortRef.current = null;
				}
				return currentResult;
			});
			if (!result) return;

			if (trackCommand) {
				dispatch(
					result.ok
						? { type: "commandSucceeded", kind: "refresh" }
						: { type: "commandFailed", kind: "refresh", error: result.error },
				);
			}
		},
		[addToast, dispatch, getControllerLifetimeSignal, stateRef],
	);

	useEffect(() => {
		void refreshResumableSessions(false);
	}, [refreshResumableSessions]);

	useEffect(() => {
		const crawlId = state.activeCrawlId;
		if (
			!crawlId ||
			state.connectionState === "connected" ||
			state.runPhase === "idle" ||
			state.runPhase === "paused" ||
			state.runPhase === "interrupted" ||
			isTerminalRunPhase(state.runPhase)
		) {
			return;
		}

		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		const poll = async () => {
			await synchronizeDurableSnapshot(crawlId);
			if (!cancelled) {
				retryTimer = setTimeout(() => {
					void poll();
				}, DURABLE_RECOVERY_RETRY_MS);
			}
		};

		retryTimer = setTimeout(() => {
			void poll();
		}, DURABLE_RECOVERY_RETRY_MS);

		return () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
		};
	}, [state.activeCrawlId, state.connectionState, state.runPhase]);

	useEffect(() => {
		return () => {
			commandAbortRef.current?.abort();
			cancelResumableRefresh();
			closeSubscription();
			cancelDurableSync();
		};
	}, []);

	const handleTargetChange = useCallback(
		(nextTarget: string) => {
			dispatch({
				type: "crawlOptionsChanged",
				crawlOptions: { ...stateRef.current.crawlOptions, target: nextTarget },
			});
		},
		[dispatch, stateRef],
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
			const lifetimeSignal = getControllerLifetimeSignal();
			if (lifetimeSignal.aborted) return false;
			const pendingOperation = startOperationRef.current;
			if (!pendingOperation && !state.crawlOptions.target.trim()) {
				addToast("error", "Please enter a target URL!");
				return false;
			}
			if (!canStartCommand(stateRef.current, "start")) {
				addToast("warning", "Another command is already running");
				return false;
			}

			let operation = pendingOperation;
			if (!operation) {
				const validationResult = normalizeCanonicalHttpUrl(state.crawlOptions.target);
				if ("error" in validationResult) {
					addToast("error", validationResult.error);
					return false;
				}

				const normalizedTarget = validationResult.url;
				if (normalizedTarget !== state.crawlOptions.target) {
					dispatch({
						type: "crawlOptionsChanged",
						crawlOptions: { ...state.crawlOptions, target: normalizedTarget },
					});
				}
				operation = {
					crawlId: crypto.randomUUID(),
					options: { ...state.crawlOptions, target: normalizedTarget },
				};
				startOperationRef.current = operation;
			} else if (!crawlOptionsEqual(operation.options, state.crawlOptions)) {
				addToast("info", "Reconciling the previous unacknowledged crawl request");
			}

			dispatch({ type: "commandStarted", kind: "start" });

			if (isQuick) {
				addToast("info", "Lightning Strike! Skipping animation...");
			}

			let result: ApiResult<CrawlSummary>;
			try {
				result = await createCrawl(operation.crawlId, operation.options, lifetimeSignal);
			} catch (error) {
				result = { ok: false, error: formatControllerError(error) };
			}
			if (lifetimeSignal.aborted) return false;

			let recoveryResult: ApiResult<CrawlRecoverySnapshot> | null = null;
			let recoveredSnapshot: CrawlRecoverySnapshot | null = null;
			if (!result.ok) {
				try {
					const recovery = await getCrawlRecoverySnapshot(operation.crawlId, lifetimeSignal);
					recoveryResult = recovery;
					if (recovery.ok) {
						if (crawlOptionsEqual(recovery.data.crawl.options, operation.options)) {
							recoveredSnapshot = recovery.data;
							result = { ok: true, data: recovery.data.crawl };
						}
					}
				} catch {
					// The stable operation ID remains owned by the controller so a
					// later retry cannot create duplicate work.
				}
			}
			if (lifetimeSignal.aborted) return false;

			if (!result.ok) {
				if (
					isStartOperationSettled(result, recoveryResult) &&
					startOperationRef.current?.crawlId === operation.crawlId
				) {
					startOperationRef.current = null;
				}
				dispatch({ type: "commandFailed", kind: "start", error: result.error });
				return false;
			}
			if (startOperationRef.current?.crawlId === operation.crawlId) {
				startOperationRef.current = null;
			}

			dispatch({ type: "liveStateReset" });
			dispatch({
				type: "crawlAccepted",
				crawlId: result.data.id,
				kind: "start",
				crawlOptions: result.data.options,
			});
			if (recoveredSnapshot) {
				dispatch({
					type: "crawlRecoverySnapshotSynchronized",
					snapshot: recoveredSnapshot,
				});
			} else {
				dispatch({ type: "crawlSummarySynchronized", crawl: result.data });
			}
			if (!isActiveCrawlStatus(result.data.status)) {
				if (isResumableCrawlStatus(result.data.status)) {
					void refreshResumableSessions(false);
				}
				return false;
			}
			dispatch({
				type: "logAppended",
				message: "Initiating Miku Beam Sequence...",
				level: "info",
			});
			connectToEvents(result.data.id);
			return true;
		},
		[
			addToast,
			dispatch,
			getControllerLifetimeSignal,
			refreshResumableSessions,
			state.crawlOptions,
			stateRef,
		],
	);

	const executeStopCommand = useCallback(
		(crawlId: string, kind: "stop" | "forceStop", mode: StopCrawlMode) =>
			executeCommand(
				kind,
				(signal) => stopCrawlRequest(crawlId, mode, signal),
				(crawl) => dispatch({ type: "crawlSummarySynchronized", crawl }),
				async (_failure, signal) => {
					const recovery = await getCrawlRecoverySnapshot(crawlId, signal);
					return recovery.ok ? recovery.data.crawl : undefined;
				},
			),
		[dispatch, executeCommand],
	);

	const pauseCrawl = useCallback(async () => {
		if (!state.activeCrawlId || !canRequestPause(state.runPhase)) return;
		const crawlId = state.activeCrawlId;

		await executeStopCommand(crawlId, "stop", "pause");
	}, [executeStopCommand, state.activeCrawlId, state.runPhase]);

	const forceStopCrawl = useCallback(async () => {
		if (!state.activeCrawlId || state.pendingCommand === "forceStop") {
			return;
		}
		const crawlId = state.activeCrawlId;

		await executeStopCommand(crawlId, "forceStop", "force");
	}, [executeStopCommand, state.activeCrawlId, state.pendingCommand]);

	const resumeCrawl = useCallback(
		async (sessionId: string) => {
			const lifetimeSignal = getControllerLifetimeSignal();
			if (lifetimeSignal.aborted) return false;
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
			cancelResumableRefresh();
			dispatch({ type: "resumableSessionResuming", sessionId });
			dispatch({ type: "commandStarted", kind: "resume" });

			let result: ApiResult<CrawlRecoverySnapshot>;
			try {
				result = await resumeCrawlRequest(sessionId, lifetimeSignal);
			} catch (error) {
				result = { ok: false, error: formatControllerError(error) };
			}
			if (lifetimeSignal.aborted) return false;

			if (!result.ok) {
				try {
					const recovery = await getCrawlRecoverySnapshot(sessionId, lifetimeSignal);
					if (recovery.ok && !isResumableCrawlStatus(recovery.data.crawl.status)) {
						result = recovery;
					}
				} catch {
					// A retry addresses the same crawl ID and is idempotent at the server.
				}
			}
			if (lifetimeSignal.aborted) return false;

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
			dispatch({ type: "crawlOptionsChanged", crawlOptions: result.data.crawl.options });
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
			if (!isActiveCrawlStatus(result.data.crawl.status)) {
				return false;
			}
			addToast("info", "Resuming saved crawl...");
			connectToEvents(result.data.crawl.id);
			return true;
		},
		[addToast, dispatch, getControllerLifetimeSignal, stateRef],
	);

	const exportCurrentCrawl = useCallback(
		async (format: CrawlExportFormat) => {
			if (!state.activeCrawlId) {
				addToast("warning", "No crawl selected for export");
				return;
			}
			const crawlId = state.activeCrawlId;
			const signal = getControllerLifetimeSignal();

			try {
				const result = await downloadCrawlExport(crawlId, format, signal);
				if (signal.aborted) return;
				if (!result.ok) {
					addToast("error", result.error);
					return;
				}

				const url = URL.createObjectURL(result.data.blob);
				const anchor = document.createElement("a");
				anchor.href = url;
				anchor.download = result.data.filename;
				document.body.appendChild(anchor);
				anchor.click();
				setTimeout(() => {
					anchor.remove();
					URL.revokeObjectURL(url);
				}, 100);
				addToast("success", `${format.toUpperCase()} download ready`);
			} catch (error) {
				if (!signal.aborted) addToast("error", formatControllerError(error));
			}
		},
		[addToast, getControllerLifetimeSignal, state.activeCrawlId],
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

			cancelResumableRefresh();
			dispatch({ type: "resumableSessionDeleting", sessionId });
			const result = await executeCommand("delete", (signal) => deleteCrawl(sessionId, signal));
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

		if (!query || !crawlId) {
			setPageSearch({ pages: [], count: 0, isLoading: false, error: null });
			return;
		}

		const controller = new AbortController();
		setPageSearch({ pages: [], count: 0, isLoading: true, error: null });

		void searchStoredPages(crawlId, query, controller.signal)
			.then((result) => {
				if (controller.signal.aborted) {
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
				if (controller.signal.aborted) {
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

	const displayedPages = state.searchQuery.trim() ? pageSearch.pages : state.crawledPages;
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
		target: state.crawlOptions.target,
		activeCrawlId: state.activeCrawlId,
		crawlOptions: state.crawlOptions,
		activeCrawlOptions: state.activeCrawlOptions,
		setCrawlOptions,
		handleTargetChange,
		stats: state.stats,
		queueStats: state.queueStats,
		crawledPages: state.crawledPages,
		storedPageCount: state.storedPageCount,
		progress: state.progress,
		runPhase: state.runPhase,
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
		refreshResumableSessions,
		deleteResumableSession,
		startCrawl,
		pauseCrawl,
		forceStopCrawl,
		resumeCrawl,
		exportCrawl: exportCurrentCrawl,
	};
}

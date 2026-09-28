import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type {
	CrawlExportFormat,
	CrawlOptions,
	CrawlRecoverySnapshot,
	CrawlSummary,
	ResumableSessionSummary,
	StopCrawlMode,
} from "../../shared/contracts/index.js";
import {
	crawlOptionsEqual,
	isActiveCrawlStatus,
	isResumableCrawlStatus,
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
} from "../api/crawls";
import { getApiErrorMessage } from "../api/errors";
import type { ApiFailure, ApiResult } from "../api/result";
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
import { useCrawlLiveConnection } from "./useCrawlLiveConnection";
import { useStoredPageSearch } from "./useStoredPageSearch";

const COMMAND_BUSY_MESSAGE = "Another command is already running";

/** A command's settled result, or null when the controller lifetime or a superseding command abandoned it. */
type CommandOutcome<T> = ApiResult<T> | null;

interface CommandSpec<T> {
	request(signal: AbortSignal): Promise<ApiResult<T>>;
	/** Applies accepted data before the command is marked successful. */
	onSuccess?(data: T): void;
	/** Reads durable crawl state after a failed request so the reducer can reconcile an ambiguous failure. */
	recoverCrawl?(signal: AbortSignal): Promise<CrawlSummary | undefined>;
}

interface StartOperation {
	crawlId: string;
	options: CrawlOptions;
}

interface AcceptedStart {
	crawl: CrawlSummary;
	/** Present when the durable recovery snapshot, not the create response, proved acceptance. */
	snapshot: CrawlRecoverySnapshot | null;
}

async function settleRequest<T>(request: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
	try {
		return await request();
	} catch (error) {
		return { ok: false, error: getApiErrorMessage(error) };
	}
}

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
	// dispatch is the only writer of controller state, so it keeps this ref current.
	const stateRef = useRef(state);

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
	const resumableRefreshAbortRef = useRef<AbortController | null>(null);
	const resumableRefreshQueueRef = useRef({ queued: false });
	const startOperationRef = useRef<StartOperation | null>(null);
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
	const pageSearch = useStoredPageSearch({
		crawlId: state.activeCrawlId,
		query: state.searchQuery,
		storedPageCount: state.storedPageCount,
		runPhase: state.runPhase,
	});

	const ensureCommandAvailable = useCallback(
		(kind: CommandKind) => {
			if (canStartCommand(stateRef.current, kind)) return true;
			addToast("warning", COMMAND_BUSY_MESSAGE);
			return false;
		},
		[addToast, stateRef],
	);

	/** Sole owner of command admission, cancellation, reconciliation and completion. */
	const executeCommand = useCallback(
		async <T>(kind: CommandKind, spec: CommandSpec<T>): Promise<CommandOutcome<T>> => {
			if (!ensureCommandAvailable(kind)) {
				return { ok: false, error: COMMAND_BUSY_MESSAGE };
			}
			if (kind === "forceStop") {
				commandAbortRef.current?.abort();
			}
			const commandController = new AbortController();
			commandAbortRef.current = commandController;
			const signal = AbortSignal.any([getControllerLifetimeSignal(), commandController.signal]);
			if (signal.aborted) return null;
			dispatch({ type: "commandStarted", kind });
			const result = await settleRequest(() => spec.request(signal));
			if (commandAbortRef.current === commandController) {
				commandAbortRef.current = null;
			}
			if (signal.aborted) return null;

			if (!result.ok) {
				let recoveredCrawl: CrawlSummary | undefined;
				try {
					recoveredCrawl = await spec.recoverCrawl?.(signal);
				} catch {
					// The original command failure remains authoritative when recovery also fails.
				}
				if (signal.aborted) return null;
				dispatch({
					type: "commandFailed",
					kind,
					error: result.error,
					...(recoveredCrawl ? { recoveredCrawl } : {}),
				});
				return result;
			}

			try {
				spec.onSuccess?.(result.data);
			} catch (error) {
				const message = getApiErrorMessage(error);
				dispatch({ type: "commandFailed", kind, error: message });
				return { ok: false, error: message };
			}
			dispatch({ type: "commandSucceeded", kind });
			return result;
		},
		[dispatch, ensureCommandAvailable, getControllerLifetimeSignal],
	);

	const cancelResumableRefresh = useEffectEvent(() => {
		resumableRefreshQueueRef.current.queued = false;
		resumableRefreshAbortRef.current?.abort();
		resumableRefreshAbortRef.current = null;
	});

	/** Loads the list, coalescing requests made while one is in flight; null when superseded. */
	const loadResumableSessions = useCallback(
		(commandSignal?: AbortSignal) =>
			drainQueuedRefreshes(resumableRefreshQueueRef.current, async () => {
				const controller = new AbortController();
				resumableRefreshAbortRef.current = controller;
				const signal = AbortSignal.any([
					getControllerLifetimeSignal(),
					controller.signal,
					...(commandSignal ? [commandSignal] : []),
				]);
				dispatch({ type: "resumableSessionsLoading" });
				const result = await settleRequest(() => listResumableCrawls(signal));

				if (signal.aborted || resumableRefreshAbortRef.current !== controller) return null;
				dispatch(
					result.ok
						? { type: "resumableSessionsLoaded", sessions: result.data }
						: { type: "resumableSessionsFailed", error: result.error },
				);
				resumableRefreshAbortRef.current = null;
				return result;
			}),
		[dispatch, getControllerLifetimeSignal],
	);

	const refreshResumableSessionList = useCallback(
		async (trackCommand: boolean) => {
			if (stateRef.current.resumableSessions.resumingId) {
				return;
			}
			if (resumableRefreshAbortRef.current) {
				resumableRefreshQueueRef.current.queued = true;
				return;
			}
			if (!trackCommand) {
				await loadResumableSessions();
				return;
			}
			await executeCommand<ResumableSessionSummary[]>("refresh", {
				request: async (signal) =>
					(await loadResumableSessions(signal)) ?? {
						ok: false,
						error: "Resumable session refresh was cancelled",
					},
			});
		},
		[executeCommand, loadResumableSessions, stateRef],
	);

	const refreshResumableSessions = useCallback(
		() => refreshResumableSessionList(true),
		[refreshResumableSessionList],
	);

	useEffect(() => {
		void refreshResumableSessionList(false);
	}, [refreshResumableSessionList]);

	useEffect(() => {
		return () => {
			commandAbortRef.current?.abort();
			cancelResumableRefresh();
		};
	}, []);

	const connectToEvents = useCrawlLiveConnection({
		activeCrawlId: state.activeCrawlId,
		connectionState: state.connectionState,
		runPhase: state.runPhase,
		readState: () => stateRef.current,
		dispatch,
		getLifetimeSignal: getControllerLifetimeSignal,
		onSettled: () => {
			void refreshResumableSessionList(false);
		},
		onRecoveryError: (message) => addToast("warning", message),
	});

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
		(next: CrawlOptions | ((previous: CrawlOptions) => CrawlOptions)) => {
			const nextValue = typeof next === "function" ? next(state.crawlOptions) : next;
			dispatch({ type: "crawlOptionsChanged", crawlOptions: nextValue });
		},
		[dispatch, state.crawlOptions],
	);

	const releaseStartOperation = useCallback((operation: StartOperation) => {
		if (startOperationRef.current?.crawlId === operation.crawlId) {
			startOperationRef.current = null;
		}
	}, []);

	/** Creates the operation's crawl, or proves from durable state that an earlier attempt did. */
	const requestStart = useCallback(
		async (operation: StartOperation, signal: AbortSignal): Promise<ApiResult<AcceptedStart>> => {
			const result = await settleRequest(() =>
				createCrawl(operation.crawlId, operation.options, signal),
			);
			if (result.ok) {
				releaseStartOperation(operation);
				return { ok: true, data: { crawl: result.data, snapshot: null } };
			}
			if (signal.aborted) return result;

			let recovery: ApiResult<CrawlRecoverySnapshot> | null = null;
			try {
				recovery = await getCrawlRecoverySnapshot(operation.crawlId, signal);
			} catch {
				// The stable operation ID remains owned by the controller so a
				// later retry cannot create duplicate work.
			}
			if (signal.aborted) return result;
			if (recovery?.ok && crawlOptionsEqual(recovery.data.crawl.options, operation.options)) {
				releaseStartOperation(operation);
				return { ok: true, data: { crawl: recovery.data.crawl, snapshot: recovery.data } };
			}
			if (isStartOperationSettled(result, recovery)) {
				releaseStartOperation(operation);
			}
			return result;
		},
		[releaseStartOperation],
	);

	const startCrawl = useCallback(
		async (isQuick = false) => {
			if (getControllerLifetimeSignal().aborted) return false;
			const { crawlOptions } = stateRef.current;
			let operation = startOperationRef.current;
			if (!operation && !crawlOptions.target.trim()) {
				addToast("error", "Please enter a target URL!");
				return false;
			}
			if (!ensureCommandAvailable("start")) {
				return false;
			}

			if (!operation) {
				const validationResult = normalizeCanonicalHttpUrl(crawlOptions.target);
				if ("error" in validationResult) {
					addToast("error", validationResult.error);
					return false;
				}

				const normalizedTarget = validationResult.url;
				if (normalizedTarget !== crawlOptions.target) {
					dispatch({
						type: "crawlOptionsChanged",
						crawlOptions: { ...crawlOptions, target: normalizedTarget },
					});
				}
				operation = {
					crawlId: crypto.randomUUID(),
					options: { ...crawlOptions, target: normalizedTarget },
				};
				startOperationRef.current = operation;
			} else if (!crawlOptionsEqual(operation.options, crawlOptions)) {
				addToast("info", "Reconciling the previous unacknowledged crawl request");
			}

			const pendingOperation = operation;
			const outcome = await executeCommand("start", {
				request: (signal) => {
					if (isQuick) {
						addToast("info", "Lightning Strike! Skipping animation...");
					}
					return requestStart(pendingOperation, signal);
				},
				onSuccess: ({ crawl, snapshot }) => {
					dispatch({ type: "liveStateReset" });
					dispatch({
						type: "crawlAccepted",
						crawlId: crawl.id,
						kind: "start",
						crawlOptions: crawl.options,
					});
					dispatch(
						snapshot
							? { type: "crawlRecoverySnapshotSynchronized", snapshot }
							: { type: "crawlSummarySynchronized", crawl },
					);
					if (!isActiveCrawlStatus(crawl.status)) {
						if (isResumableCrawlStatus(crawl.status)) {
							void refreshResumableSessionList(false);
						}
						return;
					}
					dispatch({
						type: "logAppended",
						message: "Initiating Miku Beam Sequence...",
						level: "info",
					});
					connectToEvents(crawl.id);
				},
			});
			return outcome?.ok === true && isActiveCrawlStatus(outcome.data.crawl.status);
		},
		[
			addToast,
			connectToEvents,
			dispatch,
			ensureCommandAvailable,
			executeCommand,
			getControllerLifetimeSignal,
			refreshResumableSessionList,
			requestStart,
			stateRef,
		],
	);

	const executeStopCommand = useCallback(
		(crawlId: string, kind: "stop" | "forceStop", mode: StopCrawlMode) =>
			executeCommand(kind, {
				request: (signal) => stopCrawlRequest(crawlId, mode, signal),
				onSuccess: (crawl) => dispatch({ type: "crawlSummarySynchronized", crawl }),
				recoverCrawl: async (signal) => {
					const recovery = await getCrawlRecoverySnapshot(crawlId, signal);
					return recovery.ok ? recovery.data.crawl : undefined;
				},
			}),
		[dispatch, executeCommand],
	);

	const pauseCrawl = useCallback(async () => {
		if (!state.activeCrawlId || !canRequestPause(state.runPhase)) return;
		await executeStopCommand(state.activeCrawlId, "stop", "pause");
	}, [executeStopCommand, state.activeCrawlId, state.runPhase]);

	const forceStopCrawl = useCallback(async () => {
		if (!state.activeCrawlId || state.pendingCommand === "forceStop") return;
		await executeStopCommand(state.activeCrawlId, "forceStop", "force");
	}, [executeStopCommand, state.activeCrawlId, state.pendingCommand]);

	/** Admits one resumable-session mutation; the reducer rejects a second while one is pending. */
	const canMutateResumableSession = useCallback(
		(kind: "resume" | "delete") => {
			if (!ensureCommandAvailable(kind)) return false;
			const { deletingId, resumingId } = stateRef.current.resumableSessions;
			return deletingId === null && resumingId === null;
		},
		[ensureCommandAvailable, stateRef],
	);

	const resumeCrawl = useCallback(
		async (sessionId: string) => {
			if (getControllerLifetimeSignal().aborted) return false;
			if (!canMutateResumableSession("resume")) return false;
			cancelResumableRefresh();
			dispatch({ type: "resumableSessionResuming", sessionId });

			const outcome = await executeCommand("resume", {
				request: async (signal) => {
					const result = await settleRequest(() => resumeCrawlRequest(sessionId, signal));
					if (result.ok || signal.aborted) return result;
					try {
						const recovery = await getCrawlRecoverySnapshot(sessionId, signal);
						if (recovery.ok && !isResumableCrawlStatus(recovery.data.crawl.status)) {
							return recovery;
						}
					} catch {
						// A retry addresses the same crawl ID and is idempotent at the server.
					}
					return result;
				},
				onSuccess: (snapshot) => {
					dispatch({ type: "liveStateReset" });
					dispatch({ type: "crawlOptionsChanged", crawlOptions: snapshot.crawl.options });
					dispatch({
						type: "crawlAccepted",
						crawlId: snapshot.crawl.id,
						kind: "resume",
						crawlOptions: snapshot.crawl.options,
					});
					dispatch({ type: "crawlRecoverySnapshotSynchronized", snapshot });
					dispatch({ type: "resumableSessionRemoved", sessionId });
					if (!isActiveCrawlStatus(snapshot.crawl.status)) return;
					addToast("info", "Resuming saved crawl...");
					connectToEvents(snapshot.crawl.id);
				},
			});
			if (outcome === null) return false;
			if (!outcome.ok) {
				dispatch({ type: "resumableSessionResumeFinished", sessionId });
				return false;
			}
			return isActiveCrawlStatus(outcome.data.crawl.status);
		},
		[
			addToast,
			canMutateResumableSession,
			connectToEvents,
			dispatch,
			executeCommand,
			getControllerLifetimeSignal,
		],
	);

	const deleteResumableSession = useCallback(
		async (sessionId: string) => {
			if (!canMutateResumableSession("delete")) return false;
			cancelResumableRefresh();
			dispatch({ type: "resumableSessionDeleting", sessionId });
			const outcome = await executeCommand("delete", {
				request: (signal) => deleteCrawl(sessionId, signal),
			});
			if (outcome === null) return false;
			if (!outcome.ok) {
				dispatch({ type: "resumableSessionDeleteFailed", sessionId, error: outcome.error });
				return false;
			}
			dispatch({ type: "resumableSessionDeleted", sessionId });
			return true;
		},
		[canMutateResumableSession, dispatch, executeCommand],
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
				if (!signal.aborted) addToast("error", getApiErrorMessage(error));
			}
		},
		[addToast, getControllerLifetimeSignal, state.activeCrawlId],
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
		searchResults: pageSearch.results,
		searchResultCount: pageSearch.count,
		isSearchingPages: pageSearch.isLoading,
		pageSearchError: pageSearch.error,
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

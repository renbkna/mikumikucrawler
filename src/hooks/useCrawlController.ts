import {
	startTransition,
	useCallback,
	useEffect,
	useEffectEvent,
	useMemo,
	useRef,
	useState,
} from "react";
import type { CrawlSummary } from "../../shared/contracts/crawl.js";
import type { CrawlEventEnvelope } from "../../shared/contracts/events.js";
import type { CrawlExportFormat } from "../api/crawls";
import {
	createCrawl,
	deleteCrawl,
	exportCrawl,
	listInterruptedCrawls,
	resumeCrawl as resumeCrawlRequest,
	stopCrawl as stopCrawlRequest,
	subscribeToCrawlEvents,
} from "../api/crawls";
import { normalizeHttpUrl } from "../../shared/url";
import type { Toast } from "../types";
import {
	type CrawlControllerAction,
	type CommandKind,
	type CrawlControllerState,
	crawlControllerReducer,
	createInitialCrawlControllerState,
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

	return { state, dispatch };
}

export function useCrawlController({ addToast }: UseCrawlControllerOptions) {
	const { state, dispatch } = useControllerState({ addToast });
	const subscriptionRef = useRef<ReturnType<
		typeof subscribeToCrawlEvents
	> | null>(null);

	const executeCommand = useCallback(
		async <T>(
			kind: CommandKind,
			request: () => Promise<
				{ ok: true; data: T } | { ok: false; error: string }
			>,
			onSuccess?: (data: T) => Promise<void> | void,
		) => {
			dispatch({ type: "commandStarted", kind });
			const result = await request();
			if (!result.ok) {
				dispatch({ type: "commandFailed", kind, error: result.error });
				return result;
			}

			dispatch({ type: "commandSucceeded", kind });
			await onSuccess?.(result.data);
			return result;
		},
		[dispatch],
	);

	const closeSubscription = useEffectEvent(() => {
		subscriptionRef.current?.close();
		subscriptionRef.current = null;
	});

	const applyEnvelope = useEffectEvent((envelope: CrawlEventEnvelope) => {
		startTransition(() => {
			dispatch({ type: "sseEventReceived", envelope });
		});

		if (
			envelope.type === "crawl.completed" ||
			envelope.type === "crawl.failed" ||
			envelope.type === "crawl.stopped"
		) {
			closeSubscription();
			void refreshInterruptedSessions(false);
		}
	});

	const connectToEvents = useEffectEvent((crawlId: string) => {
		closeSubscription();
		dispatch({ type: "connectionChanged", connectionState: "connecting" });
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

	const refreshInterruptedSessions = useCallback(
		async (trackCommand = true) => {
			if (trackCommand) {
				dispatch({ type: "commandStarted", kind: "refresh" });
			}
			dispatch({ type: "interruptedSessionsLoading" });
			const result = await listInterruptedCrawls();
			if (!result.ok) {
				dispatch({
					type: "interruptedSessionsFailed",
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
				type: "interruptedSessionsLoaded",
				sessions: result.data,
			});
			if (trackCommand) {
				dispatch({ type: "commandSucceeded", kind: "refresh" });
			}
		},
		[dispatch],
	);

	useEffect(() => {
		void refreshInterruptedSessions(false);
	}, [refreshInterruptedSessions]);

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

			const validationResult = normalizeHttpUrl(state.target);
			if ("error" in validationResult) {
				addToast("error", validationResult.error);
				return false;
			}

			const normalizedTarget = validationResult.url;
			if (normalizedTarget !== state.target) {
				dispatch({ type: "targetChanged", target: normalizedTarget });
			}

			dispatch({ type: "liveStateReset" });
			dispatch({ type: "commandStarted", kind: "start" });

			if (isQuick) {
				addToast("info", "Lightning Strike! Skipping animation...");
			}

			const result = await createCrawl({
				...state.crawlOptions,
				target: normalizedTarget,
			});

			if (!result.ok) {
				dispatch({ type: "commandFailed", kind: "start", error: result.error });
				return false;
			}

			dispatch({
				type: "crawlAccepted",
				crawlId: result.data.id,
				kind: "start",
			});
			dispatch({
				type: "logAppended",
				message: "Initiating Miku Beam Sequence...",
			});
			connectToEvents(result.data.id);
			return true;
		},
		[addToast, dispatch, state.crawlOptions, state.target],
	);

	const stopCrawl = useCallback(async () => {
		if (!state.activeCrawlId) return;
		const crawlId = state.activeCrawlId;

		await executeCommand("stop", () => stopCrawlRequest(crawlId));
	}, [executeCommand, state.activeCrawlId]);

	const resumeCrawl = useCallback(
		async (sessionId: string, sessionTarget: string) => {
			dispatch({ type: "liveStateReset" });
			dispatch({ type: "targetChanged", target: sessionTarget });
			dispatch({ type: "commandStarted", kind: "resume" });

			const result = await resumeCrawlRequest(sessionId);
			if (!result.ok) {
				dispatch({
					type: "commandFailed",
					kind: "resume",
					error: result.error,
				});
				return false;
			}

			for (const action of getResumeHydrationActions(result.data)) {
				dispatch(action);
			}
			dispatch({
				type: "crawlAccepted",
				crawlId: result.data.id,
				kind: "resume",
			});
			dispatch({
				type: "interruptedSessionDeleted",
				sessionId,
			});
			addToast("info", "Resuming interrupted crawl...");
			connectToEvents(result.data.id);
			return true;
		},
		[addToast, dispatch],
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

	const deleteInterruptedSession = useCallback(
		async (sessionId: string) => {
			dispatch({ type: "interruptedSessionDeleting", sessionId });
			const result = await executeCommand("delete", () =>
				deleteCrawl(sessionId),
			);
			if (!result.ok) {
				dispatch({
					type: "interruptedSessionDeleteFailed",
					error: result.error,
				});
				return false;
			}

			dispatch({ type: "interruptedSessionDeleted", sessionId });
			return true;
		},
		[dispatch, executeCommand],
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
		isAttacking:
			state.runPhase === "starting" ||
			state.runPhase === "running" ||
			state.runPhase === "stopping",
		connectionState: state.connectionState,
		interruptedSessions: state.interruptedSessions.items,
		interruptedSessionsLoading: state.interruptedSessions.isLoading,
		interruptedSessionsError: state.interruptedSessions.error,
		deletingInterruptedSessionId: state.interruptedSessions.deletingId,
		refreshInterruptedSessions: () => refreshInterruptedSessions(true),
		deleteInterruptedSession,
		startCrawl,
		stopCrawl,
		resumeCrawl,
		exportCrawl: exportCurrentCrawl,
	};
}

export type UseCrawlControllerReturn = ReturnType<typeof useCrawlController>;

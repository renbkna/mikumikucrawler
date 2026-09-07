import { startTransition, useEffect, useEffectEvent, useRef } from "react";
import {
	type CrawlEventEnvelope,
	isResumableCrawlStatus,
	isSettledCrawlEventType,
	isTerminalCrawlStatus,
} from "../../shared/contracts/index.js";
import { getCrawlRecoverySnapshot, subscribeToCrawlEvents } from "../api/crawls";
import {
	type CrawlControllerAction,
	type CrawlControllerState,
	isTerminalRunPhase,
} from "./crawlControllerState";

const DURABLE_RECOVERY_RETRY_MS = 5_000;

type LiveState = Pick<CrawlControllerState, "activeCrawlId" | "lastSequence">;

/** Owns the selected stream, bounded recovery concurrency, polling and stale callback rejection. */
export function useCrawlLiveConnection({
	activeCrawlId,
	connectionState,
	runPhase,
	readState,
	dispatch,
	getLifetimeSignal,
	onSettled,
	onRecoveryError,
}: Pick<CrawlControllerState, "activeCrawlId" | "connectionState" | "runPhase"> & {
	readState(): LiveState;
	dispatch(action: CrawlControllerAction): void;
	getLifetimeSignal(): AbortSignal;
	onSettled(): void;
	onRecoveryError(message: string): void;
}) {
	const subscriptionRef = useRef<{
		crawlId: string;
		controller: AbortController;
		connection: ReturnType<typeof subscribeToCrawlEvents>;
	} | null>(null);
	const durableSyncRef = useRef<{
		crawlId: string;
		controller: AbortController;
		queued: boolean;
	} | null>(null);
	const durableSyncErrorCrawlIdRef = useRef<string | null>(null);
	const closeSubscription = useEffectEvent((crawlId?: string) => {
		const subscription = subscriptionRef.current;
		if (!subscription || (crawlId !== undefined && subscription.crawlId !== crawlId)) return;
		subscriptionRef.current = null;
		subscription.controller.abort();
		subscription.connection.close();
	});

	const cancelDurableSync = useEffectEvent(() => {
		durableSyncRef.current?.controller.abort();
		durableSyncRef.current = null;
	});

	const synchronizeDurableSnapshot = useEffectEvent(async (crawlId: string) => {
		const lifetimeSignal = getLifetimeSignal();
		if (lifetimeSignal.aborted || readState().activeCrawlId !== crawlId) return;
		const current = durableSyncRef.current;
		if (current?.crawlId === crawlId) {
			current.queued = true;
			return;
		}
		cancelDurableSync();
		const job = { crawlId, controller: new AbortController(), queued: false };
		durableSyncRef.current = job;
		const signal = AbortSignal.any([lifetimeSignal, job.controller.signal]);
		const isCurrent = () =>
			!signal.aborted && durableSyncRef.current === job && readState().activeCrawlId === crawlId;
		try {
			do {
				job.queued = false;
				try {
					const snapshotResult = await getCrawlRecoverySnapshot(crawlId, signal);
					if (!isCurrent()) return;
					if (!snapshotResult.ok) throw new Error(snapshotResult.error);
					dispatch({ type: "crawlRecoverySnapshotSynchronized", snapshot: snapshotResult.data });
					if (
						isResumableCrawlStatus(snapshotResult.data.crawl.status) ||
						isTerminalCrawlStatus(snapshotResult.data.crawl.status)
					) {
						closeSubscription(crawlId);
						onSettled();
					}
					durableSyncErrorCrawlIdRef.current = null;
				} catch (error) {
					if (!isCurrent()) return;
					if (durableSyncErrorCrawlIdRef.current !== crawlId) {
						durableSyncErrorCrawlIdRef.current = crawlId;
						onRecoveryError(
							`Could not refresh stored crawl state: ${error instanceof Error ? error.message : "Request failed"}`,
						);
					}
				}
			} while (job.queued && isCurrent());
		} finally {
			if (durableSyncRef.current === job) durableSyncRef.current = null;
		}
	});

	const applyEnvelope = useEffectEvent((envelope: CrawlEventEnvelope) => {
		if (readState().activeCrawlId !== envelope.crawlId) return;
		const hasSequenceGap = envelope.sequence > readState().lastSequence + 1;
		startTransition(() => {
			dispatch({ type: "sseEventReceived", envelope });
		});
		if (hasSequenceGap && readState().activeCrawlId === envelope.crawlId) {
			void synchronizeDurableSnapshot(envelope.crawlId);
		}

		if (
			subscriptionRef.current?.crawlId === envelope.crawlId &&
			isSettledCrawlEventType(envelope.type)
		) {
			closeSubscription(envelope.crawlId);
		}
		if (isSettledCrawlEventType(envelope.type)) {
			onSettled();
		}
	});

	const connectToEvents = useEffectEvent((crawlId: string) => {
		const lifetimeSignal = getLifetimeSignal();
		if (lifetimeSignal.aborted) return;
		closeSubscription();
		cancelDurableSync();
		durableSyncErrorCrawlIdRef.current = null;
		dispatch({ type: "connectionChanged", connectionState: "connecting" });
		const subscriptionController = new AbortController();
		const isCurrent = () => !lifetimeSignal.aborted && !subscriptionController.signal.aborted;
		const connection = subscribeToCrawlEvents(crawlId, {
			onOpen: () => {
				if (!isCurrent()) return;
				dispatch({ type: "connectionChanged", connectionState: "connected" });
			},
			onError: () => {
				if (!isCurrent()) return;
				dispatch({
					type: "connectionChanged",
					connectionState: "disconnected",
				});
				void synchronizeDurableSnapshot(crawlId);
			},
			onInvalidEvent: () => {
				if (!isCurrent()) return;
				void synchronizeDurableSnapshot(crawlId);
			},
			onEvent: (event) => {
				if (isCurrent()) applyEnvelope(event);
			},
		});
		subscriptionRef.current = { crawlId, controller: subscriptionController, connection };
		void synchronizeDurableSnapshot(crawlId);
	});
	useEffect(() => {
		const crawlId = activeCrawlId;
		if (
			!crawlId ||
			connectionState === "connected" ||
			runPhase === "idle" ||
			runPhase === "paused" ||
			runPhase === "interrupted" ||
			isTerminalRunPhase(runPhase)
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
	}, [activeCrawlId, connectionState, runPhase]);

	useEffect(
		() => () => {
			closeSubscription();
			cancelDurableSync();
		},
		[],
	);
	return connectToEvents;
}

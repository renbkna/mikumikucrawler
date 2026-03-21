import {
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import { api, getBackendUrl } from "../api/client";
import type { SessionSummary } from "../components";
import { CRAWLER_DEFAULTS, TOAST_DEFAULTS, UI_LIMITS } from "../constants";
import type {
	CrawledPage,
	CrawlOptions,
	QueueStats,
	Stats,
	Toast,
} from "../types";

export type ConnectionState = "connecting" | "connected" | "disconnected";

type PageAction = { type: "add"; page: CrawledPage } | { type: "reset" };

function pagesReducer(state: CrawledPage[], action: PageAction): CrawledPage[] {
	switch (action.type) {
		case "add": {
			const next = [action.page, ...state];
			return next.length > UI_LIMITS.MAX_PAGE_BUFFER
				? next.slice(0, UI_LIMITS.MAX_PAGE_BUFFER)
				: next;
		}
		case "reset":
			return [];
	}
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

function normalizeAndValidateUrl(
	url: string,
): { url: string } | { error: string } {
	try {
		let normalizedUrl = url;
		if (!/^https?:\/\//i.test(url)) {
			normalizedUrl = `http://${url}`;
		}
		new URL(normalizedUrl);
		return { url: normalizedUrl };
	} catch {
		return { error: "Please enter a valid URL" };
	}
}

function getTreatyErrorMessage(errorValue: unknown): string {
	if (!errorValue || typeof errorValue !== "object") {
		return "Request failed";
	}

	if ("error" in errorValue && typeof errorValue.error === "string") {
		return errorValue.error;
	}

	if ("message" in errorValue && typeof errorValue.message === "string") {
		return errorValue.message;
	}

	return "Request failed";
}

interface UseCrawlControllerOptions {
	addToast: (type: Toast["type"], message: string, timeout?: number) => void;
}

export function useCrawlController({ addToast }: UseCrawlControllerOptions) {
	const [target, setTarget] = useState("");
	const [crawlOptions, setCrawlOptions] = useState<CrawlOptions>({
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
	});
	const [crawlId, setCrawlId] = useState<string | null>(null);
	const [isAttacking, setIsAttacking] = useState(false);
	const [connectionState, setConnectionState] =
		useState<ConnectionState>("connected");
	const [stats, setStats] = useState<Stats>(INITIAL_STATS);
	const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
	const [crawledPages, dispatchPages] = useReducer(pagesReducer, []);
	const [progress, setProgress] = useState(0);
	const [logs, setLogs] = useState<string[]>([]);
	const [filterText, setFilterText] = useState("");
	const [interruptedSessions, setInterruptedSessions] = useState<
		SessionSummary[]
	>([]);

	const eventSourceRef = useRef<EventSource | null>(null);
	const queueStatsRef = useRef<QueueStats | null>(null);
	const fallbackToastShownRef = useRef(false);
	const maxPagesRef = useRef(crawlOptions.maxPages);

	useEffect(() => {
		maxPagesRef.current = crawlOptions.maxPages;
	}, [crawlOptions.maxPages]);

	const handleTargetChange = useCallback((nextTarget: string) => {
		setTarget(nextTarget);
		setCrawlOptions((previous) => ({ ...previous, target: nextTarget }));
	}, []);

	const resetLiveState = useCallback(() => {
		setStats(INITIAL_STATS);
		setQueueStats(null);
		queueStatsRef.current = null;
		dispatchPages({ type: "reset" });
		setProgress(0);
		setLogs([]);
		setFilterText("");
		fallbackToastShownRef.current = false;
	}, []);

	const addLog = useCallback(
		(message: string) => {
			setLogs((previous) =>
				[message, ...previous].slice(0, UI_LIMITS.MAX_LOGS),
			);
			if (
				message.toLowerCase().includes("falling back to static crawling") &&
				!fallbackToastShownRef.current
			) {
				addToast(
					"warning",
					"Tip: Try disabling JavaScript crawling in settings for better performance",
					TOAST_DEFAULTS.LONG_TIMEOUT,
				);
				fallbackToastShownRef.current = true;
			}
		},
		[addToast],
	);

	const updateProgress = useCallback(
		(nextStats: Stats, nextQueue: QueueStats | null) => {
			const queueSize =
				nextQueue?.queueLength ?? queueStatsRef.current?.queueLength ?? 0;
			const activeSize =
				nextQueue?.activeRequests ?? queueStatsRef.current?.activeRequests ?? 0;
			const scanned = nextStats.pagesScanned ?? 0;
			const totalWork = scanned + queueSize + activeSize;
			const effectiveTotal = Math.max(totalWork, maxPagesRef.current, 1);
			setProgress(
				totalWork > 0 ? Math.min((scanned / effectiveTotal) * 100, 100) : 0,
			);
		},
		[],
	);

	const closeEventSource = useCallback(() => {
		eventSourceRef.current?.close();
		eventSourceRef.current = null;
	}, []);

	const refreshInterruptedSessions = useCallback(async () => {
		const response = await api.api.crawls.get({
			query: { status: "interrupted" },
		});

		if (response.error || !response.data) {
			return;
		}

		setInterruptedSessions(
			response.data.crawls.map(
				(crawl: (typeof response.data.crawls)[number]) => ({
					id: crawl.id,
					target: crawl.target,
					status: crawl.status,
					pagesScanned: crawl.counters.pagesScanned,
					createdAt: crawl.createdAt,
					updatedAt: crawl.updatedAt,
				}),
			),
		);
	}, []);

	useEffect(() => {
		void refreshInterruptedSessions();
	}, [refreshInterruptedSessions]);

	const connectToEvents = useCallback(
		(nextCrawlId: string) => {
			closeEventSource();
			setConnectionState("connecting");
			const source = new EventSource(
				`${getBackendUrl()}/api/crawls/${nextCrawlId}/events`,
			);

			const handleEnvelope = (raw: MessageEvent<string>) => {
				const envelope = JSON.parse(raw.data) as {
					type: string;
					payload: Record<string, unknown>;
				};

				switch (envelope.type) {
					case "crawl.log": {
						const message = String(envelope.payload.message ?? "");
						if (message) {
							addLog(message);
						}
						break;
					}
					case "crawl.page": {
						dispatchPages({
							type: "add",
							page: envelope.payload as unknown as CrawledPage,
						});
						break;
					}
					case "crawl.progress": {
						const counters = envelope.payload.counters as Parameters<
							typeof buildStats
						>[0];
						const nextQueue = envelope.payload.queue as QueueStats;
						const nextStats = buildStats(counters, {
							elapsedSeconds: Number(envelope.payload.elapsedSeconds ?? 0),
							pagesPerSecond: Number(envelope.payload.pagesPerSecond ?? 0),
						});
						queueStatsRef.current = nextQueue;
						setQueueStats(nextQueue);
						setStats(nextStats);
						updateProgress(nextStats, nextQueue);
						break;
					}
					case "crawl.completed":
					case "crawl.stopped":
					case "crawl.failed": {
						const counters = envelope.payload.counters as Parameters<
							typeof buildStats
						>[0];
						const nextStats = buildStats(counters);
						setStats(nextStats);
						setIsAttacking(false);
						setConnectionState("connected");
						setProgress(100);
						closeEventSource();
						void refreshInterruptedSessions();

						if (envelope.type === "crawl.completed") {
							addToast(
								"success",
								`Crawl completed! Scanned ${nextStats.pagesScanned} pages`,
								TOAST_DEFAULTS.LONG_TIMEOUT,
							);
						} else if (envelope.type === "crawl.stopped") {
							addToast("info", "Crawler stopped");
						} else {
							addToast(
								"error",
								String(envelope.payload.error ?? "Crawl failed"),
							);
						}
						break;
					}
					default:
						break;
				}
			};

			source.onopen = () => {
				setConnectionState("connected");
			};
			source.onerror = () => {
				setConnectionState("disconnected");
			};

			for (const type of [
				"crawl.log",
				"crawl.page",
				"crawl.progress",
				"crawl.completed",
				"crawl.stopped",
				"crawl.failed",
			]) {
				source.addEventListener(type, handleEnvelope as EventListener);
			}

			eventSourceRef.current = source;
		},
		[
			addLog,
			addToast,
			closeEventSource,
			refreshInterruptedSessions,
			updateProgress,
		],
	);

	useEffect(() => () => closeEventSource(), [closeEventSource]);

	const startCrawl = useCallback(
		async (isQuick = false) => {
			if (!target.trim()) {
				addToast("error", "Please enter a target URL!");
				return false;
			}

			const validationResult = normalizeAndValidateUrl(target);
			if ("error" in validationResult) {
				addToast("error", validationResult.error);
				return false;
			}

			const normalizedTarget = validationResult.url;
			if (normalizedTarget !== target) {
				handleTargetChange(normalizedTarget);
			}

			resetLiveState();
			setIsAttacking(true);

			if (isQuick) {
				addToast("info", "Lightning Strike! Skipping animation...");
			}

			const response = await api.api.crawls.post({
				...crawlOptions,
				target: normalizedTarget,
			});

			if (response.error || !response.data) {
				setIsAttacking(false);
				addToast("error", getTreatyErrorMessage(response.error?.value));
				return false;
			}

			setCrawlId(response.data.id);
			connectToEvents(response.data.id);
			addLog("Initiating Miku Beam Sequence...");
			return true;
		},
		[
			addLog,
			addToast,
			connectToEvents,
			crawlOptions,
			handleTargetChange,
			resetLiveState,
			target,
		],
	);

	const stopCrawl = useCallback(async () => {
		if (!crawlId) return;
		await api.api.crawls({ id: crawlId }).stop.post();
	}, [crawlId]);

	const resumeCrawl = useCallback(
		async (sessionId: string, sessionTarget: string) => {
			resetLiveState();
			handleTargetChange(sessionTarget);
			addLog(`[Resume] Continuing crawl of ${sessionTarget}...`);

			const response = await api.api.crawls({ id: sessionId }).resume.post();
			if (response.error || !response.data) {
				addToast("error", getTreatyErrorMessage(response.error?.value));
				return false;
			}

			setCrawlId(response.data.id);
			setIsAttacking(true);
			connectToEvents(response.data.id);
			setInterruptedSessions((previous: SessionSummary[]) =>
				previous.filter((session) => session.id !== sessionId),
			);
			addToast("info", "Resuming interrupted crawl...");
			return true;
		},
		[addLog, addToast, connectToEvents, handleTargetChange, resetLiveState],
	);

	const exportCrawl = useCallback(
		async (format: string) => {
			if (!crawlId) {
				addToast("warning", "No crawl selected for export");
				return;
			}

			const response = await fetch(
				`${getBackendUrl()}/api/crawls/${crawlId}/export?format=${format}`,
			);

			if (!response.ok) {
				addToast("error", "Failed to export crawl");
				return;
			}

			const blob = await response.blob();
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `miku-crawler-export.${format}`;
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
		[addToast, crawlId],
	);

	const filteredPages = useMemo(() => {
		if (!filterText.trim()) return crawledPages;
		const loweredFilter = filterText.toLowerCase();
		return crawledPages.filter(
			(page) =>
				page.url.toLowerCase().includes(loweredFilter) ||
				page.title?.toLowerCase().includes(loweredFilter) ||
				page.description?.toLowerCase().includes(loweredFilter),
		);
	}, [crawledPages, filterText]);

	return {
		target,
		crawlOptions,
		setCrawlOptions,
		handleTargetChange,
		stats,
		queueStats,
		crawledPages,
		progress,
		logs,
		setLogs,
		filterText,
		setFilterText,
		displayedPages: filterText.trim() ? filteredPages : crawledPages,
		clearFilter: () => setFilterText(""),
		isAttacking,
		connectionState,
		interruptedSessions,
		startCrawl,
		stopCrawl,
		resumeCrawl,
		exportCrawl,
	};
}

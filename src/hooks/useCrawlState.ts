import { useCallback, useMemo, useReducer, useState } from "react";
import { CRAWLER_DEFAULTS, UI_LIMITS } from "../constants";
import type { CrawledPage, CrawlOptions, QueueStats, Stats } from "../types";

type PageAction = { type: "add"; page: CrawledPage } | { type: "reset" };

/**
 * Reducer function to manage the list of captured pages with buffer limits.
 */
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
		default:
			return state;
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

export interface UseCrawlStateReturn {
	target: string;
	setTarget: (target: string) => void;
	crawlOptions: CrawlOptions;
	setCrawlOptions: React.Dispatch<React.SetStateAction<CrawlOptions>>;
	handleTargetChange: (newTarget: string) => void;
	stats: Stats;
	setStats: React.Dispatch<React.SetStateAction<Stats>>;
	queueStats: QueueStats | null;
	setQueueStats: React.Dispatch<React.SetStateAction<QueueStats | null>>;
	resetStats: () => void;
	crawledPages: CrawledPage[];
	addPage: (page: CrawledPage) => void;
	resetPages: () => void;
	progress: number;
	setProgress: React.Dispatch<React.SetStateAction<number>>;
	logs: string[];
	setLogs: React.Dispatch<React.SetStateAction<string[]>>;
	filterText: string;
	setFilterText: React.Dispatch<React.SetStateAction<string>>;
	filteredPages: CrawledPage[];
	isFilterActive: boolean;
	displayedPages: CrawledPage[];
	clearFilter: () => void;
}

/** Centralizes the state for crawl configuration, statistics, and captured data. */
export function useCrawlState(): UseCrawlStateReturn {
	const [target, setTarget] = useState("");
	const [crawlOptions, setCrawlOptions] = useState<CrawlOptions>({
		target: "",
		crawlMethod: CRAWLER_DEFAULTS.CRAWL_METHOD,
		crawlDepth: CRAWLER_DEFAULTS.CRAWL_DEPTH,
		crawlDelay: CRAWLER_DEFAULTS.CRAWL_DELAY,
		maxPages: CRAWLER_DEFAULTS.MAX_PAGES,
		maxConcurrentRequests: CRAWLER_DEFAULTS.MAX_CONCURRENT_REQUESTS,
		retryLimit: CRAWLER_DEFAULTS.RETRY_LIMIT,
		dynamic: CRAWLER_DEFAULTS.DYNAMIC,
		respectRobots: CRAWLER_DEFAULTS.RESPECT_ROBOTS,
		contentOnly: CRAWLER_DEFAULTS.CONTENT_ONLY,
		saveMedia: CRAWLER_DEFAULTS.SAVE_MEDIA,
	});

	const [stats, setStats] = useState<Stats>(INITIAL_STATS);
	const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
	const [crawledPages, dispatchPages] = useReducer(pagesReducer, []);
	const [progress, setProgress] = useState(0);
	const [logs, setLogs] = useState<string[]>([]);
	const [filterText, setFilterText] = useState("");

	const handleTargetChange = useCallback((newTarget: string) => {
		setTarget(newTarget);
		setCrawlOptions((prev) => ({ ...prev, target: newTarget }));
	}, []);

	const addPage = useCallback((page: CrawledPage) => {
		dispatchPages({ type: "add", page });
	}, []);

	const resetPages = useCallback(() => {
		dispatchPages({ type: "reset" });
	}, []);

	const resetStats = useCallback(() => {
		setStats(INITIAL_STATS);
		setProgress(0);
	}, []);

	const clearFilter = useCallback(() => setFilterText(""), []);

	const filteredPages = useMemo(() => {
		if (!filterText.trim()) return crawledPages;
		const lowerFilter = filterText.toLowerCase();
		return crawledPages.filter(
			(page) =>
				page.url.toLowerCase().includes(lowerFilter) ||
				page.title?.toLowerCase().includes(lowerFilter) ||
				page.description?.toLowerCase().includes(lowerFilter),
		);
	}, [crawledPages, filterText]);

	const isFilterActive = filterText.trim().length > 0;
	const displayedPages = isFilterActive ? filteredPages : crawledPages;

	return {
		target,
		setTarget,
		crawlOptions,
		setCrawlOptions,
		handleTargetChange,
		stats,
		setStats,
		queueStats,
		setQueueStats,
		resetStats,
		crawledPages,
		addPage,
		resetPages,
		progress,
		setProgress,
		logs,
		setLogs,
		filterText,
		setFilterText,
		filteredPages,
		isFilterActive,
		displayedPages,
		clearFilter,
	};
}

export { INITIAL_STATS };

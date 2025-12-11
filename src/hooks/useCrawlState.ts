import { useCallback, useMemo, useReducer, useState } from "react";
import { CRAWLER_DEFAULTS, UI_LIMITS } from "../constants";
import type { CrawledPage, CrawlOptions, QueueStats, Stats } from "../types";

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
		default:
			return state;
	}
}

// ===========================================
// 📦 INITIAL STATS STATE
// ===========================================
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
	// Crawl options
	target: string;
	setTarget: (target: string) => void;
	advancedOptions: CrawlOptions;
	setAdvancedOptions: React.Dispatch<React.SetStateAction<CrawlOptions>>;
	handleTargetChange: (newTarget: string) => void;

	// Stats
	stats: Stats;
	setStats: React.Dispatch<React.SetStateAction<Stats>>;
	queueStats: QueueStats | null;
	setQueueStats: React.Dispatch<React.SetStateAction<QueueStats | null>>;
	resetStats: () => void;

	// Pages
	crawledPages: CrawledPage[];
	addPage: (page: CrawledPage) => void;
	resetPages: () => void;

	// Progress
	progress: number;
	setProgress: React.Dispatch<React.SetStateAction<number>>;

	// Logs
	logs: string[];
	setLogs: React.Dispatch<React.SetStateAction<string[]>>;

	// Filter
	filterText: string;
	setFilterText: React.Dispatch<React.SetStateAction<string>>;
	filteredPages: CrawledPage[];
	isFilterActive: boolean;
	displayedPages: CrawledPage[];
	clearFilter: () => void;
}

export function useCrawlState(): UseCrawlStateReturn {
	// Target and options
	const [target, setTarget] = useState("");
	const [advancedOptions, setAdvancedOptions] = useState<CrawlOptions>({
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

	// Stats
	const [stats, setStats] = useState<Stats>(INITIAL_STATS);
	const [queueStats, setQueueStats] = useState<QueueStats | null>(null);

	// Pages (using reducer for optimized updates)
	const [crawledPages, dispatchPages] = useReducer(pagesReducer, []);

	// Progress
	const [progress, setProgress] = useState(0);

	// Logs
	const [logs, setLogs] = useState<string[]>([]);

	// Filter
	const [filterText, setFilterText] = useState("");

	// Handlers
	const handleTargetChange = useCallback((newTarget: string) => {
		setTarget(newTarget);
		setAdvancedOptions((prev) => ({ ...prev, target: newTarget }));
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

	// Memoized filtered pages computation for performance
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
	// Both filteredPages and crawledPages are already memoized, no need for additional memo
	const displayedPages = isFilterActive ? filteredPages : crawledPages;

	return {
		target,
		setTarget,
		advancedOptions,
		setAdvancedOptions,
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

import type {
	CrawlStats,
	QueueStats,
	SanitizedCrawlOptions,
} from "../../types.js";

/** Tracks the ongoing progress, statistics, and domain state of a crawl session. */
export class CrawlState {
	private readonly options: SanitizedCrawlOptions;
	private readonly startTime: number;
	public isActive: boolean;
	private readonly visited: Set<string>;
	private readonly domainDelays: Map<string, number>;
	public stats: CrawlStats;

	constructor(options: SanitizedCrawlOptions) {
		this.options = options;
		this.startTime = Date.now();
		this.isActive = true;
		this.visited = new Set();
		this.domainDelays = new Map();
		this.stats = {
			pagesScanned: 0,
			linksFound: 0,
			totalData: 0,
			mediaFiles: 0,
			successCount: 0,
			failureCount: 0,
			skippedCount: 0,
		};
	}

	/**
	 * Checks if the session is still active and hasn't hit the page limit.
	 */
	canProcessMore(): boolean {
		return this.isActive && this.stats.pagesScanned < this.options.maxPages;
	}

	stop(): void {
		this.isActive = false;
	}

	hasVisited(url: string): boolean {
		return this.visited.has(url);
	}

	markVisited(url: string): void {
		this.visited.add(url);
	}

	setDomainDelay(domain: string, delay: number): void {
		this.domainDelays.set(domain, delay);
	}

	getDomainDelay(domain: string): number {
		return this.domainDelays.get(domain) ?? this.options.crawlDelay;
	}

	/**
	 * Records a successful page crawl and updates metrics.
	 * @param contentLength - Raw size of the page content in bytes.
	 */
	recordSuccess(contentLength: number): void {
		this.stats.pagesScanned += 1;
		this.stats.successCount = (this.stats.successCount ?? 0) + 1;

		if (typeof contentLength === "number" && Number.isFinite(contentLength)) {
			this.stats.totalData += Math.floor(contentLength / 1024);
		}
	}

	recordFailure(): void {
		this.stats.failureCount = (this.stats.failureCount ?? 0) + 1;
	}

	recordSkip(): void {
		this.stats.skippedCount = (this.stats.skippedCount ?? 0) + 1;
	}

	addLinks(count: number): void {
		if (count > 0) {
			this.stats.linksFound += count;
		}
	}

	addMedia(count: number): void {
		if (count > 0) {
			this.stats.mediaFiles = (this.stats.mediaFiles ?? 0) + count;
		}
	}

	/**
	 * Generates a point-in-time snapshot of the crawler's performance metrics.
	 */
	snapshotQueueMetrics(queueLength: number, activeCount: number): QueueStats {
		const elapsedSeconds = Math.max(
			Math.floor((Date.now() - this.startTime) / 1000),
			0,
		);
		const pagesPerSecond = elapsedSeconds
			? Number((this.stats.pagesScanned / elapsedSeconds).toFixed(2))
			: 0;

		return {
			activeRequests: activeCount,
			queueLength,
			elapsedTime: elapsedSeconds,
			pagesPerSecond,
		};
	}

	/**
	 * Computes the final statistics including totals, rates, and elapsed time.
	 */
	buildFinalStats(): CrawlStats & {
		elapsedTime: { hours: number; minutes: number; seconds: number };
		pagesPerSecond: string;
		successRate: string;
	} {
		const elapsedSeconds = Math.max(
			Math.floor((Date.now() - this.startTime) / 1000),
			0,
		);

		const elapsedTime = {
			hours: Math.floor(elapsedSeconds / 3600),
			minutes: Math.floor((elapsedSeconds % 3600) / 60),
			seconds: elapsedSeconds % 60,
		};

		const pagesPerSecond = elapsedSeconds
			? Number((this.stats.pagesScanned / elapsedSeconds).toFixed(2))
			: 0;

		const successRate = this.stats.pagesScanned
			? `${(((this.stats.successCount ?? 0) / this.stats.pagesScanned) * 100).toFixed(1)}%`
			: "0%";

		return {
			...this.stats,
			elapsedTime,
			pagesPerSecond: pagesPerSecond.toFixed(2),
			successRate,
		};
	}
}

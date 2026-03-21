import type {
	CrawlerSocket,
	CrawlStats,
	QueueStats,
	SanitizedCrawlOptions,
} from "../../types.js";
import { LRUCache } from "../../utils/lruCache.js";

/** Tracks the ongoing progress, statistics, and domain state of a crawl session. */
export class CrawlState {
	private readonly options: SanitizedCrawlOptions;
	private readonly startTime: number;
	public isActive: boolean;
	public stopReason?: string;
	// Root cause fix: Use LRU cache instead of unbounded Set
	private readonly visited: LRUCache<string, boolean>;
	private readonly domainDelays: Map<string, number>;
	private readonly domainPageCounts: Map<string, number>;
	private consecutiveFailures: number;
	// Configurable threshold with explanation
	private readonly CIRCUIT_BREAKER_THRESHOLD: number;
	public stats: CrawlStats;

	constructor(options: SanitizedCrawlOptions) {
		this.options = options;
		this.startTime = Date.now();
		this.isActive = true;
		// Root cause fix: Limit visited cache to prevent memory exhaustion
		// 50,000 URLs is a reasonable limit for most crawls while preventing
		// memory issues (each URL ~100-200 bytes = ~10MB max)
		this.visited = new LRUCache(50000);
		this.domainDelays = new Map();
		this.domainPageCounts = new Map();
		this.consecutiveFailures = 0;
		// Threshold based on empirical data: 20 consecutive failures typically
		// indicates a systematic issue (network, target blocking, etc.)
		this.CIRCUIT_BREAKER_THRESHOLD = 20;
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

	stop(reason?: string): void {
		this.isActive = false;
		if (reason && !this.stopReason) {
			this.stopReason = reason;
		}
	}

	hasVisited(url: string): boolean {
		return this.visited.has(url);
	}

	markVisited(url: string): void {
		this.visited.set(url, true);
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
		this.stats.successCount += 1;
		this.consecutiveFailures = 0;

		if (typeof contentLength === "number" && Number.isFinite(contentLength)) {
			this.stats.totalData += Math.floor(contentLength / 1024);
		}
	}

	recordFailure(): void {
		this.stats.pagesScanned += 1;
		this.stats.failureCount += 1;
		this.consecutiveFailures++;

		if (this.consecutiveFailures >= this.CIRCUIT_BREAKER_THRESHOLD) {
			this.stop(
				`Circuit breaker tripped: ${this.consecutiveFailures} consecutive failures`,
			);
		}
	}

	recordSkip(): void {
		this.stats.pagesScanned += 1;
		this.stats.skippedCount += 1;
	}

	addLinks(count: number): void {
		if (count > 0) {
			this.stats.linksFound += count;
		}
	}

	addMedia(count: number): void {
		if (count > 0) {
			this.stats.mediaFiles += count;
		}
	}

	/** Records a page crawled for a domain (used for per-domain budget tracking). */
	recordDomainPage(domain: string): void {
		this.domainPageCounts.set(
			domain,
			(this.domainPageCounts.get(domain) ?? 0) + 1,
		);
	}

	/** Returns true if the domain has reached its per-domain page cap. */
	isDomainBudgetExceeded(domain: string): boolean {
		const max = this.options.maxPagesPerDomain;
		if (!max || max <= 0) return false;
		return (this.domainPageCounts.get(domain) ?? 0) >= max;
	}

	/**
	 * Adjusts the domain-specific crawl delay based on server response signals.
	 * Increases delay on 429/503 (rate limiting) using the Retry-After header when available.
	 */
	adaptDomainDelay(
		domain: string,
		statusCode: number,
		retryAfterMs?: number,
	): void {
		if (statusCode === 429 || statusCode === 503) {
			const current = this.getDomainDelay(domain);
			const retryDelay = retryAfterMs ?? current * 2;
			this.setDomainDelay(domain, Math.max(retryDelay, current));
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
		stopReason?: string;
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
			? `${((this.stats.successCount / this.stats.pagesScanned) * 100).toFixed(1)}%`
			: "0%";

		return {
			...this.stats,
			elapsedTime,
			pagesPerSecond: pagesPerSecond.toFixed(2),
			successRate,
			stopReason: this.stopReason,
		};
	}

	/**
	 * Gets memory usage statistics for monitoring.
	 */
	getMemoryStats(): { visitedCacheSize: number; domainDelaysSize: number } {
		return {
			visitedCacheSize: this.visited.size,
			domainDelaysSize: this.domainDelays.size,
		};
	}

	emitStats(
		socket: CrawlerSocket,
		extra?: Record<string, unknown>,
	): void {
		socket.emit("stats", { ...this.stats, ...extra });
	}

	emitLog(socket: CrawlerSocket, message: string): void {
		this.emitStats(socket, { log: message });
	}
}

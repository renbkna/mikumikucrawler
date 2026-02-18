import type {
	CrawlStats,
	QueueStats,
	SanitizedCrawlOptions,
} from "../../types.js";
import { ADAPTIVE_THROTTLE } from "../../constants.js";
import { LRUCache } from "../../utils/lruCache.js";

/** Tracks the ongoing progress, statistics, and domain state of a crawl session. */
export class CrawlState {
	private readonly options: SanitizedCrawlOptions;
	private readonly startTime: number;
	public isActive: boolean;
	public stopReason?: string;
	// Use LRU cache instead of unbounded Set to prevent memory exhaustion
	private readonly visited: LRUCache<string, boolean>;
	private readonly domainDelays: Map<string, number>;
	/** Per-domain page count for enforcing maxPagesPerDomain budget. */
	private readonly domainPageCounts: Map<string, number>;
	private consecutiveFailures: number;
	// Configurable threshold with explanation
	private readonly CIRCUIT_BREAKER_THRESHOLD: number;
	public stats: CrawlStats;

	constructor(options: SanitizedCrawlOptions) {
		this.options = options;
		this.startTime = Date.now();
		this.isActive = true;
		// Limit visited cache to prevent memory exhaustion
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
	 * Checks if the session is still active and hasn't hit the global page limit.
	 */
	canProcessMore(): boolean {
		return this.isActive && this.stats.pagesScanned < this.options.maxPages;
	}

	/**
	 * Returns true when the per-domain crawl budget has been reached for the given
	 * domain. Always returns false when maxPagesPerDomain is 0 (unlimited).
	 */
	isDomainBudgetExceeded(domain: string): boolean {
		const budget = this.options.maxPagesPerDomain ?? 0;
		if (budget <= 0) return false;
		return (this.domainPageCounts.get(domain) ?? 0) >= budget;
	}

	/**
	 * Increments the per-domain page counter. Call after a successful page save.
	 */
	recordDomainPage(domain: string): void {
		this.domainPageCounts.set(
			domain,
			(this.domainPageCounts.get(domain) ?? 0) + 1,
		);
	}

	/**
	 * Adjusts the per-domain crawl delay based on observed response time and
	 * HTTP status code (adaptive throttling).
	 *
	 * Rules:
	 * - 429/503 → multiply current delay by 3, respect Retry-After if larger.
	 * - responseMs > SLOW_RESPONSE_MS → multiply by SLOW_FACTOR.
	 * - responseMs < FAST_RESPONSE_MS → multiply by FAST_FACTOR (min = configured delay).
	 */
	adaptDomainDelay(
		domain: string,
		responseMs: number,
		statusCode: number,
		retryAfterMs?: number,
	): void {
		const current = this.getDomainDelay(domain);

		if (statusCode === 429 || statusCode === 503) {
			const backoff = Math.max(current * 3, retryAfterMs ?? 0);
			this.domainDelays.set(
				domain,
				Math.min(backoff, ADAPTIVE_THROTTLE.MAX_DELAY_MS),
			);
			return;
		}

		if (responseMs > ADAPTIVE_THROTTLE.SLOW_RESPONSE_MS) {
			const slower = Math.min(
				current * ADAPTIVE_THROTTLE.SLOW_FACTOR,
				ADAPTIVE_THROTTLE.MAX_DELAY_MS,
			);
			this.domainDelays.set(domain, slower);
			return;
		}

		if (responseMs < ADAPTIVE_THROTTLE.FAST_RESPONSE_MS) {
			const floor = this.options.crawlDelay;
			const faster = Math.max(current * ADAPTIVE_THROTTLE.FAST_FACTOR, floor);
			// Only update if we actually changed; avoids repeated Map writes at the floor
			if (faster < current) {
				this.domainDelays.set(domain, faster);
			}
		}
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
		this.stats.successCount = (this.stats.successCount ?? 0) + 1;
		this.consecutiveFailures = 0;

		if (typeof contentLength === "number" && Number.isFinite(contentLength)) {
			this.stats.totalData += Math.floor(contentLength / 1024);
		}
	}

	recordFailure(): void {
		this.stats.failureCount = (this.stats.failureCount ?? 0) + 1;
		this.consecutiveFailures++;

		if (this.consecutiveFailures >= this.CIRCUIT_BREAKER_THRESHOLD) {
			this.stop(
				`Circuit breaker tripped: ${this.consecutiveFailures} consecutive failures`,
			);
		}
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
			? `${(((this.stats.successCount ?? 0) / this.stats.pagesScanned) * 100).toFixed(1)}%`
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
	getMemoryStats(): {
		visitedCacheSize: number;
		domainDelaysSize: number;
		domainPageCountsSize: number;
	} {
		return {
			visitedCacheSize: this.visited.size,
			domainDelaysSize: this.domainDelays.size,
			domainPageCountsSize: this.domainPageCounts.size,
		};
	}
}

import { ADAPTIVE_THROTTLE } from "../../constants.js";
import type {
	CrawlStats,
	QueueStats,
	SanitizedCrawlOptions,
} from "../../types.js";
import { LRUCache } from "../../utils/lruCache.js";

export class CrawlState {
	private readonly options: SanitizedCrawlOptions;
	private readonly startTime: number;
	public isActive: boolean;
	public stopReason?: string;
	private readonly visited: LRUCache<string, boolean>;
	private readonly domainDelays: Map<string, number>;
	private readonly domainPageCounts: Map<string, number>;
	private consecutiveFailures: number;
	private lastFailureTime: number;
	private readonly CIRCUIT_BREAKER_THRESHOLD: number;
	private readonly CIRCUIT_BREAKER_COOLDOWN_MS = 60000;
	public stats: CrawlStats;

	constructor(options: SanitizedCrawlOptions) {
		this.options = options;
		this.startTime = Date.now();
		this.isActive = true;
		this.visited = new LRUCache(50000);
		this.domainDelays = new Map();
		this.domainPageCounts = new Map();
		this.consecutiveFailures = 0;
		this.lastFailureTime = 0;
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

	canProcessMore(): boolean {
		return this.isActive && this.stats.pagesScanned < this.options.maxPages;
	}

	isDomainBudgetExceeded(domain: string): boolean {
		const budget = this.options.maxPagesPerDomain ?? 0;
		if (budget <= 0) return false;
		return (this.domainPageCounts.get(domain) ?? 0) >= budget;
	}

	recordDomainPage(domain: string): void {
		this.domainPageCounts.set(
			domain,
			(this.domainPageCounts.get(domain) ?? 0) + 1,
		);
	}

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

	recordSuccess(contentLength: number): void {
		this.stats.pagesScanned += 1;
		this.stats.successCount = (this.stats.successCount ?? 0) + 1;
		this.consecutiveFailures = 0;
		this.lastFailureTime = 0;

		if (typeof contentLength === "number" && Number.isFinite(contentLength)) {
			this.stats.totalData += Math.floor(contentLength / 1024);
		}
	}

	private shouldTripCircuitBreaker(previousFailureTime: number): boolean {
		if (this.consecutiveFailures < this.CIRCUIT_BREAKER_THRESHOLD) {
			return false;
		}

		const now = Date.now();
		if (
			previousFailureTime > 0 &&
			now - previousFailureTime > this.CIRCUIT_BREAKER_COOLDOWN_MS
		) {
			this.consecutiveFailures = 1;
			this.lastFailureTime = now;
			this.isActive = true;
			this.stopReason = undefined;
			return false;
		}

		return true;
	}

	recordFailure(): void {
		this.stats.failureCount = (this.stats.failureCount ?? 0) + 1;
		this.consecutiveFailures++;
		const previousFailureTime = this.lastFailureTime;
		this.lastFailureTime = Date.now();

		if (this.shouldTripCircuitBreaker(previousFailureTime)) {
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

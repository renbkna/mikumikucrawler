import type { CrawlCounters, CrawlOptions } from "../../contracts/crawl.js";
import { LRUCache } from "../../utils/lruCache.js";

type TerminalOutcome = "success" | "failure" | "skip";

const FAILURE_CIRCUIT_BREAKER_THRESHOLD = 20;

export interface QueueSnapshot {
	activeRequests: number;
	queueLength: number;
}

export class CrawlState {
	private readonly visited = new LRUCache<string, true>(50_000);
	private readonly terminalOutcomes = new Map<string, TerminalOutcome>();
	private readonly domainDelays = new Map<string, number>();
	private readonly domainNextAllowedAt = new Map<string, number>();
	private readonly domainPageCounts = new Map<string, number>();
	private consecutiveFailures = 0;
	private readonly startedAtMs = Date.now();
	private stopRequested = false;

	readonly counters: CrawlCounters;
	stopReason: string | null = null;

	constructor(
		private readonly options: CrawlOptions,
		initialCounters?: CrawlCounters,
	) {
		this.counters = initialCounters ?? {
			pagesScanned: 0,
			successCount: 0,
			failureCount: 0,
			skippedCount: 0,
			linksFound: 0,
			mediaFiles: 0,
			totalDataKb: 0,
		};
	}

	get isStopRequested(): boolean {
		return this.stopRequested;
	}

	canScheduleMore(): boolean {
		return (
			!this.stopRequested && this.counters.pagesScanned < this.options.maxPages
		);
	}

	hasVisited(url: string): boolean {
		return this.visited.has(url);
	}

	markVisited(url: string): void {
		this.visited.set(url, true);
	}

	restoreVisited(urls: string[]): void {
		for (const url of urls) {
			this.markVisited(url);
			try {
				const domain = new URL(url).hostname;
				this.recordDomainPage(domain);
			} catch {}
		}
	}

	requestStop(reason: string): void {
		this.stopRequested = true;
		this.stopReason = this.stopReason ?? reason;
	}

	setDomainDelay(domain: string, delayMs: number): void {
		this.domainDelays.set(domain, delayMs);
	}

	getDomainDelay(domain: string): number {
		return this.domainDelays.get(domain) ?? this.options.crawlDelay;
	}

	timeUntilDomainReady(domain: string, now = Date.now()): number {
		const nextAllowedAt = this.domainNextAllowedAt.get(domain) ?? 0;
		return Math.max(nextAllowedAt - now, 0);
	}

	reserveDomain(domain: string, now = Date.now()): void {
		this.domainNextAllowedAt.set(domain, now + this.getDomainDelay(domain));
	}

	adaptDomainDelay(
		domain: string,
		statusCode: number,
		retryAfterMs?: number,
	): void {
		if (statusCode !== 429 && statusCode !== 503 && statusCode !== 403) {
			return;
		}

		const currentDelay = this.getDomainDelay(domain);
		const nextDelay =
			statusCode === 403
				? currentDelay * 2
				: Math.max(currentDelay, retryAfterMs ?? currentDelay * 2);
		this.setDomainDelay(domain, nextDelay);
	}

	recordDomainPage(domain: string): void {
		this.domainPageCounts.set(
			domain,
			(this.domainPageCounts.get(domain) ?? 0) + 1,
		);
	}

	isDomainBudgetExceeded(domain: string): boolean {
		const budget = this.options.maxPagesPerDomain;
		if (budget <= 0) return false;
		return (this.domainPageCounts.get(domain) ?? 0) >= budget;
	}

	recordDiscoveredLinks(count: number): void {
		if (count > 0) {
			this.counters.linksFound += count;
		}
	}

	recordMedia(count: number): void {
		if (count > 0) {
			this.counters.mediaFiles += count;
		}
	}

	recordTerminal(
		url: string,
		outcome: TerminalOutcome,
		options: { dataKb?: number; mediaFiles?: number } = {},
	): boolean {
		if (this.terminalOutcomes.has(url)) {
			return false;
		}

		this.terminalOutcomes.set(url, outcome);
		this.markVisited(url);
		this.counters.pagesScanned += 1;

		switch (outcome) {
			case "success":
				this.counters.successCount += 1;
				this.counters.totalDataKb += Math.max(
					Math.floor(options.dataKb ?? 0),
					0,
				);
				this.consecutiveFailures = 0;
				break;
			case "failure":
				this.counters.failureCount += 1;
				this.consecutiveFailures += 1;
				if (this.consecutiveFailures >= FAILURE_CIRCUIT_BREAKER_THRESHOLD) {
					this.requestStop(
						`Circuit breaker tripped after ${this.consecutiveFailures} consecutive failures`,
					);
				}
				break;
			case "skip":
				this.counters.skippedCount += 1;
				break;
		}

		if (options.mediaFiles) {
			this.counters.mediaFiles += options.mediaFiles;
		}

		return true;
	}

	buildProgress(queue: QueueSnapshot) {
		const elapsedSeconds = Math.max(
			Math.floor((Date.now() - this.startedAtMs) / 1000),
			0,
		);

		return {
			counters: this.counters,
			queue,
			elapsedSeconds,
			pagesPerSecond:
				elapsedSeconds > 0
					? Number((this.counters.pagesScanned / elapsedSeconds).toFixed(2))
					: 0,
			stopReason: this.stopReason,
		};
	}
}

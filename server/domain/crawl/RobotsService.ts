import { config } from "../../config/env.js";
import type { Logger } from "../../config/logging.js";
import { MEMORY_CONSTANTS, REQUEST_CONSTANTS } from "../../constants.js";
import { LRUCacheWithTTL } from "../../utils/lruCache.js";
import type { HttpClient } from "../../plugins/security.js";
import {
	NativeRobotsParser,
	type RobotsResult,
} from "../../utils/robotsParser.js";

export interface RobotsPolicy {
	allowed: boolean;
	crawlDelayMs?: number;
	domain: string;
}

export class RobotsService {
	private readonly cache = new LRUCacheWithTTL<string, RobotsResult | null>(
		MEMORY_CONSTANTS.ROBOTS_CACHE_MAX_SIZE,
		MEMORY_CONSTANTS.ROBOTS_CACHE_TTL_MS,
	);

	constructor(
		private readonly httpClient: HttpClient,
		private readonly logger: Logger,
	) {}

	private async fetchRulesForDomain(
		domain: string,
	): Promise<RobotsResult | null> {
		const cached = this.cache.get(domain);
		if (cached !== undefined) {
			return cached;
		}

		for (const protocol of ["https", "http"] as const) {
			try {
				const response = await this.httpClient.fetch({
					url: `${protocol}://${domain}/robots.txt`,
					headers: { "User-Agent": config.userAgent },
					signal: AbortSignal.timeout(
						REQUEST_CONSTANTS.ROBOTS_FETCH_TIMEOUT_MS,
					),
				});

				if (!response.ok) {
					continue;
				}

				const text = await response.text();
				const rules = new NativeRobotsParser(text);
				this.cache.set(domain, rules);
				return rules;
			} catch (error) {
				this.logger.debug(
					`[Robots] Failed to fetch robots.txt for ${domain}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		this.cache.set(domain, null);
		return null;
	}

	async evaluate(url: string): Promise<RobotsPolicy> {
		const domain = new URL(url).hostname;
		const rules = await this.fetchRulesForDomain(domain);
		const crawlDelaySeconds = rules?.getCrawlDelay(config.userAgent);

		return {
			domain,
			allowed: rules ? rules.isAllowed(url, config.userAgent) : true,
			crawlDelayMs: crawlDelaySeconds ? crawlDelaySeconds * 1000 : undefined,
		};
	}

	async isAllowed(url: string): Promise<boolean> {
		return (await this.evaluate(url)).allowed;
	}

	async getCrawlDelay(url: string): Promise<number | undefined> {
		return (await this.evaluate(url)).crawlDelayMs;
	}
}

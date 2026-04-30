import { config } from "../../config/env.js";
import type { Logger } from "../../config/logging.js";
import { MEMORY_CONSTANTS, REQUEST_CONSTANTS } from "../../constants.js";
import { LRUCacheWithTTL } from "../../utils/lruCache.js";
import type { HttpClient } from "../../plugins/security.js";
import {
	NativeRobotsParser,
	type RobotsResult,
} from "../../utils/robotsParser.js";
import { getCrawlUrlIdentity } from "./UrlPolicy.js";

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

	private async fetchRulesForOrigin(
		originKey: string,
	): Promise<RobotsResult | null> {
		const cached = this.cache.get(originKey);
		if (cached !== undefined) {
			return cached;
		}

		try {
			const response = await this.httpClient.fetch({
				url: `${originKey}/robots.txt`,
				headers: { "User-Agent": config.userAgent },
				signal: AbortSignal.timeout(REQUEST_CONSTANTS.ROBOTS_FETCH_TIMEOUT_MS),
			});

			if (response.ok) {
				const text = await response.text();
				const rules = new NativeRobotsParser(text);
				this.cache.set(originKey, rules);
				return rules;
			}
		} catch (error) {
			this.logger.debug(
				`[Robots] Failed to fetch robots.txt for ${originKey}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		this.cache.set(originKey, null);
		return null;
	}

	async evaluate(url: string): Promise<RobotsPolicy> {
		const identity = getCrawlUrlIdentity(url);
		if ("error" in identity) {
			throw new Error(identity.error);
		}

		const rules = await this.fetchRulesForOrigin(identity.robotsKey);
		const crawlDelaySeconds = rules?.getCrawlDelay(config.userAgent);

		return {
			domain: identity.domainBudgetKey,
			allowed: rules ? rules.isAllowed(url, config.userAgent) : true,
			crawlDelayMs:
				crawlDelaySeconds === undefined ? undefined : crawlDelaySeconds * 1000,
		};
	}

	async isAllowed(url: string): Promise<boolean> {
		return (await this.evaluate(url)).allowed;
	}

	async getCrawlDelay(url: string): Promise<number | undefined> {
		return (await this.evaluate(url)).crawlDelayMs;
	}
}

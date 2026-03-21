import { config } from "../../config/env.js";
import type { Logger } from "../../config/logging.js";
import { REQUEST_CONSTANTS } from "../../constants.js";
import type { HttpClient } from "../../plugins/security.js";
import {
	NativeRobotsParser,
	type RobotsResult,
} from "../../utils/robotsParser.js";

interface CachedRobots {
	rules: RobotsResult | null;
	expiresAt: number;
}

const ROBOTS_CACHE_TTL_MS = 30 * 60 * 1000;

export class RobotsService {
	private readonly cache = new Map<string, CachedRobots>();

	constructor(
		private readonly httpClient: HttpClient,
		private readonly logger: Logger,
	) {}

	private async fetchRulesForDomain(
		domain: string,
	): Promise<RobotsResult | null> {
		const cached = this.cache.get(domain);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.rules;
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
				this.cache.set(domain, {
					rules,
					expiresAt: Date.now() + ROBOTS_CACHE_TTL_MS,
				});
				return rules;
			} catch (error) {
				this.logger.debug(
					`[Robots] Failed to fetch robots.txt for ${domain}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		this.cache.set(domain, {
			rules: null,
			expiresAt: Date.now() + ROBOTS_CACHE_TTL_MS,
		});
		return null;
	}

	async isAllowed(url: string): Promise<boolean> {
		const domain = new URL(url).hostname;
		const rules = await this.fetchRulesForDomain(domain);
		return rules ? rules.isAllowed(url, config.userAgent) : true;
	}

	async getCrawlDelay(url: string): Promise<number | undefined> {
		const domain = new URL(url).hostname;
		const rules = await this.fetchRulesForDomain(domain);
		const crawlDelaySeconds = rules?.getCrawlDelay(config.userAgent);
		return crawlDelaySeconds ? crawlDelaySeconds * 1000 : undefined;
	}
}

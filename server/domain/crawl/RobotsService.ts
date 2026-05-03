import { config } from "../../config/env.js";
import type { Logger } from "../../config/logging.js";
import { MEMORY_CONSTANTS, REQUEST_CONSTANTS } from "../../constants.js";
import { LRUCacheWithTTL } from "../../utils/lruCache.js";
import type { HttpClient } from "../../plugins/security.js";
import {
	NativeRobotsParser,
	type RobotsResult,
} from "../../utils/robotsParser.js";
import { type CrawlUrlIdentity, getCrawlUrlIdentity } from "./UrlPolicy.js";
import { shouldTreatRobotsResponseAsNoRules } from "./httpStatusPolicy.js";

export interface RobotsPolicy {
	allowed: boolean;
	crawlDelayMs?: number;
	delayKey: string;
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
		signal?: AbortSignal,
	): Promise<RobotsResult | null> {
		const cached = this.cache.get(originKey);
		if (cached !== undefined) {
			return cached;
		}

		const timeoutSignal = AbortSignal.timeout(
			REQUEST_CONSTANTS.ROBOTS_FETCH_TIMEOUT_MS,
		);
		const fetchSignal = signal
			? AbortSignal.any([signal, timeoutSignal])
			: timeoutSignal;

		try {
			const response = await this.httpClient.fetch({
				url: `${originKey}/robots.txt`,
				headers: { "User-Agent": config.userAgent },
				signal: fetchSignal,
			});

			if (response.ok) {
				const text = await response.text();
				const rules = new NativeRobotsParser(text);
				this.cache.set(originKey, rules);
				return rules;
			}

			if (shouldTreatRobotsResponseAsNoRules(response.status)) {
				this.cache.set(originKey, null);
				return null;
			}
		} catch (error) {
			if (signal?.aborted) {
				throw signal.reason instanceof Error
					? signal.reason
					: new Error("Robots evaluation aborted");
			}

			this.logger.debug(
				`[Robots] Failed to fetch robots.txt for ${originKey}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		return null;
	}

	async evaluate(url: string, signal?: AbortSignal): Promise<RobotsPolicy> {
		const identity = getCrawlUrlIdentity(url);
		if ("error" in identity) {
			throw new Error(identity.error);
		}

		return this.evaluateIdentity(identity, signal);
	}

	async evaluateIdentity(
		identity: CrawlUrlIdentity,
		signal?: AbortSignal,
	): Promise<RobotsPolicy> {
		const rules = await this.fetchRulesForOrigin(identity.robotsKey, signal);
		const crawlDelaySeconds = rules?.getCrawlDelay(config.userAgent);

		return {
			delayKey: identity.originKey,
			allowed: rules
				? rules.isAllowed(identity.robotsMatchUrl, config.userAgent)
				: true,
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

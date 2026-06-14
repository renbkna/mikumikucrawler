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

export type RobotsPolicy =
	| {
			type: "allowed";
			crawlDelayMs?: number;
			delayKey: string;
	  }
	| {
			type: "disallowed";
			crawlDelayMs?: number;
			delayKey: string;
	  }
	| {
			type: "unavailable";
			delayKey: string;
			reason: string;
	  };

type RobotsRulesResult =
	| { type: "rules"; rules: RobotsResult }
	| { type: "no-rules" }
	| { type: "unavailable"; reason: string };

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
	): Promise<RobotsRulesResult> {
		const cached = this.cache.get(originKey);
		if (cached !== undefined) {
			return cached === null
				? { type: "no-rules" }
				: { type: "rules", rules: cached };
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
				return { type: "rules", rules };
			}

			if (shouldTreatRobotsResponseAsNoRules(response.status)) {
				this.cache.set(originKey, null);
				return { type: "no-rules" };
			}

			return {
				type: "unavailable",
				reason: `robots.txt returned HTTP ${response.status}`,
			};
		} catch (error) {
			if (signal?.aborted) {
				throw signal.reason instanceof Error
					? signal.reason
					: new Error("Robots evaluation aborted");
			}

			const reason = error instanceof Error ? error.message : String(error);
			this.logger.debug(
				`[Robots] Failed to fetch robots.txt for ${originKey}: ${reason}`,
			);
			return { type: "unavailable", reason };
		}
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
		const rulesResult = await this.fetchRulesForOrigin(
			identity.robotsKey,
			signal,
		);
		if (rulesResult.type === "unavailable") {
			return {
				type: "unavailable",
				delayKey: identity.originKey,
				reason: rulesResult.reason,
			};
		}

		const rules = rulesResult.type === "rules" ? rulesResult.rules : null;
		const crawlDelaySeconds = rules?.getCrawlDelay(config.userAgent);
		const allowed = rules
			? rules.isAllowed(identity.robotsMatchUrl, config.userAgent)
			: true;

		return {
			type: allowed ? "allowed" : "disallowed",
			delayKey: identity.originKey,
			crawlDelayMs:
				crawlDelaySeconds === undefined ? undefined : crawlDelaySeconds * 1000,
		};
	}
}

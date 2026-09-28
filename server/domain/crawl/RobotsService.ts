import { LRUCache } from "lru-cache";
import robotsParserModule from "robots-parser";
import { config } from "../../config/env.js";
import type { Logger } from "../../config/logging.js";
import { DOMAIN_DELAY_CONSTANTS, MEMORY_CONSTANTS, REQUEST_CONSTANTS } from "../../constants.js";
import { type HttpClient, isOutboundPolicyError } from "../../outbound/HttpClient.js";
import { abortError, raceAbort } from "../../utils/abort.js";
import { getErrorMessage } from "../../utils/helpers.js";
import { disposeResponseBody, readLimitedResponseBody } from "../../utils/responseBody.js";
import { SingleFlight } from "../../utils/singleFlight.js";
import { shouldTreatRobotsResponseAsNoRules } from "./httpStatusPolicy.js";
import type { CrawlUrlIdentity } from "./UrlPolicy.js";

type RobotsResult = ReturnType<typeof robotsParserModule>;
export const ROBOTS_UNAVAILABLE_CACHE_TTL_MS = 5_000;

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
	  }
	| {
			type: "blocked";
			delayKey: string;
			reason: string;
	  };

type RobotsRulesResult =
	| { type: "rules"; rules: RobotsResult }
	| { type: "no-rules" }
	| { type: "blocked"; reason: string }
	| { type: "unavailable"; reason: string };

const robotsAbortError = (signal: AbortSignal) => abortError(signal, "Robots evaluation aborted");

export class RobotsService {
	private readonly cache = new LRUCache<string, RobotsResult | false>({
		max: MEMORY_CONSTANTS.ROBOTS_CACHE_MAX_SIZE,
		ttl: MEMORY_CONSTANTS.ROBOTS_CACHE_TTL_MS,
	});
	private readonly inFlightRules = new SingleFlight<string, RobotsRulesResult>();
	private readonly unavailableCache: LRUCache<string, string>;
	private readonly lifecycleController = new AbortController();

	constructor(
		private readonly httpClient: HttpClient,
		private readonly logger: Logger,
		unavailableTtlMs = ROBOTS_UNAVAILABLE_CACHE_TTL_MS,
	) {
		this.unavailableCache = new LRUCache({
			max: MEMORY_CONSTANTS.ROBOTS_CACHE_MAX_SIZE,
			ttl: unavailableTtlMs,
		});
	}

	private async loadRulesForOrigin(
		originKey: string,
		allowLocalhostOnInitialRequest: boolean,
	): Promise<RobotsRulesResult> {
		const timeoutSignal = AbortSignal.any([
			this.lifecycleController.signal,
			AbortSignal.timeout(REQUEST_CONSTANTS.ROBOTS_FETCH_TIMEOUT_MS),
		]);

		try {
			const response = await this.httpClient.fetch({
				url: `${originKey}/robots.txt`,
				headers: { "User-Agent": config.userAgent },
				signal: timeoutSignal,
				...(allowLocalhostOnInitialRequest ? { allowLocalhostOnInitialRequest: true } : {}),
			});
			if (response.ok) {
				const body = await readLimitedResponseBody(
					response,
					REQUEST_CONSTANTS.MAX_ROBOTS_RESPONSE_BYTES,
					timeoutSignal,
				);
				if (body.type === "tooLarge") {
					return {
						type: "unavailable",
						reason: `robots.txt exceeds ${REQUEST_CONSTANTS.MAX_ROBOTS_RESPONSE_BYTES} bytes`,
					};
				}
				const text = new TextDecoder().decode(body.bytes);
				const rules = robotsParserModule(`${originKey}/robots.txt`, text);
				this.cache.set(originKey, rules);
				return { type: "rules", rules };
			}

			if (shouldTreatRobotsResponseAsNoRules(response.status)) {
				await disposeResponseBody(response);
				this.cache.set(originKey, false);
				return { type: "no-rules" };
			}

			await disposeResponseBody(response);
			return {
				type: "unavailable",
				reason: `robots.txt returned HTTP ${response.status}`,
			};
		} catch (error) {
			if (this.lifecycleController.signal.aborted) {
				throw robotsAbortError(this.lifecycleController.signal);
			}
			const reason = getErrorMessage(error);
			if (isOutboundPolicyError(error)) {
				return { type: "blocked", reason };
			}
			this.logger.debug(`[Robots] Failed to fetch robots.txt for ${originKey}: ${reason}`);
			return { type: "unavailable", reason };
		}
	}

	private cachedRules(originKey: string): RobotsRulesResult | undefined {
		const cached = this.cache.get(originKey);
		if (cached === undefined) return undefined;
		return cached === false ? { type: "no-rules" } : { type: "rules", rules: cached };
	}

	private fetchRulesForOrigin(
		originKey: string,
		signal?: AbortSignal,
		allowLocalhostOnInitialRequest = false,
	): Promise<RobotsRulesResult> {
		if (this.lifecycleController.signal.aborted) {
			return Promise.reject(robotsAbortError(this.lifecycleController.signal));
		}
		if (signal?.aborted) {
			return Promise.reject(robotsAbortError(signal));
		}

		const cached = this.cachedRules(originKey);
		if (cached) return Promise.resolve(cached);
		const requestKey = `${allowLocalhostOnInitialRequest ? "local" : "public"}:${originKey}`;
		const unavailableReason = this.unavailableCache.get(requestKey);
		if (unavailableReason !== undefined) {
			return Promise.resolve({ type: "unavailable", reason: unavailableReason });
		}

		const pending = this.inFlightRules.run(requestKey, async () => {
			const result = await this.loadRulesForOrigin(originKey, allowLocalhostOnInitialRequest);
			if (result.type === "unavailable") {
				this.unavailableCache.set(requestKey, result.reason);
			}
			return result;
		});
		return raceAbort(pending, signal, robotsAbortError);
	}

	async close(): Promise<void> {
		this.lifecycleController.abort(new Error("Robots service is shutting down"));
		await this.inFlightRules.settled();
	}

	async evaluateIdentity(
		identity: CrawlUrlIdentity,
		signal?: AbortSignal,
		options: { allowLocalhostOnInitialRequest?: boolean } = {},
	): Promise<RobotsPolicy> {
		const rulesResult = await this.fetchRulesForOrigin(
			identity.originKey,
			signal,
			options.allowLocalhostOnInitialRequest ?? false,
		);
		if (rulesResult.type === "blocked") {
			return {
				type: "blocked",
				delayKey: identity.domainBudgetKey,
				reason: rulesResult.reason,
			};
		}
		if (rulesResult.type === "unavailable") {
			return {
				type: "unavailable",
				delayKey: identity.domainBudgetKey,
				reason: rulesResult.reason,
			};
		}

		const rules = rulesResult.type === "rules" ? rulesResult.rules : null;
		const crawlDelaySeconds = rules?.getCrawlDelay(config.robotsProductToken);
		const crawlDelayMs = toBoundedRobotsDelayMs(crawlDelaySeconds);
		if (crawlDelayMs === null) {
			return {
				type: "unavailable",
				delayKey: identity.domainBudgetKey,
				reason: `robots.txt crawl-delay must be between 0 and ${DOMAIN_DELAY_CONSTANTS.MAX_MS}ms`,
			};
		}
		const allowed = rules
			? (rules.isAllowed(identity.canonicalUrl, config.robotsProductToken) ?? true)
			: true;

		return {
			type: allowed ? "allowed" : "disallowed",
			delayKey: identity.domainBudgetKey,
			...(crawlDelayMs === undefined ? {} : { crawlDelayMs }),
		};
	}
}

function toBoundedRobotsDelayMs(seconds: number | undefined): number | undefined | null {
	if (seconds === undefined) return undefined;
	const delayMs = seconds * 1000;
	if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > DOMAIN_DELAY_CONSTANTS.MAX_MS) {
		return null;
	}
	return delayMs;
}

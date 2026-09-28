import type { CrawlOptions } from "../../../shared/contracts/index.js";
import type { ExtractedLink } from "../../types.js";
import type { CrawlQueue, QueueAdmission, QueueItem } from "./CrawlQueue.js";
import type { CrawlState } from "./CrawlState.js";
import type { RobotsService } from "./RobotsService.js";
import {
	type CrawlUrlIdentity,
	type NormalizedDiscoveredLink,
	normalizeDiscoveredLink,
} from "./UrlPolicy.js";

export type CrawlAdmissionState = Pick<CrawlState, "remainingAdmissionCapacity" | "setDomainDelay">;
export type CrawlAdmissionQueue = Pick<CrawlQueue, "enqueueNormalized">;
export type RobotsPolicyEvaluator = Pick<RobotsService, "evaluateIdentity">;

export type RobotsGateResult =
	| { type: "allowed" }
	| { type: "disallowed" }
	| { type: "unavailable"; reason: string }
	| { type: "blocked"; reason: string };

/**
 * The crawl's robots.txt policy: skipped unless the crawl respects robots, and an
 * allowed destination's crawl-delay becomes that domain's scheduling delay.
 */
export async function evaluateRobotsGate(
	context: {
		options: Pick<CrawlOptions, "respectRobots">;
		state: Pick<CrawlState, "setDomainDelay">;
		robotsService: RobotsPolicyEvaluator;
	},
	identity: CrawlUrlIdentity,
	signal?: AbortSignal,
	evaluation?: { allowLocalhostOnInitialRequest?: boolean },
): Promise<RobotsGateResult> {
	if (!context.options.respectRobots) return { type: "allowed" };
	const policy = await context.robotsService.evaluateIdentity(identity, signal, evaluation);
	if (policy.type === "allowed" && policy.crawlDelayMs !== undefined) {
		context.state.setDomainDelay(policy.delayKey, policy.crawlDelayMs);
	}
	return policy;
}

export type AdmissionRejectionReason =
	| "depth-limit"
	| "nofollow"
	| "robots-disallowed"
	| "outbound-policy"
	| "queue-rejected";

export type LinkAdmissionResult =
	| {
			type: "admitted";
			item: QueueAdmission;
			link: NormalizedDiscoveredLink;
	  }
	| {
			type: "rejected";
			reason: AdmissionRejectionReason;
			url: string;
	  };

export class CrawlAdmissionPolicy {
	constructor(
		private readonly options: CrawlOptions,
		private readonly state: CrawlAdmissionState,
		private readonly queue: CrawlAdmissionQueue,
		private readonly robotsService: RobotsPolicyEvaluator,
	) {}

	normalizeDiscoveredLinks(
		documentUrl: string,
		links: ExtractedLink[],
	): NormalizedDiscoveredLink[] {
		return links.flatMap((link) => {
			const normalized = normalizeDiscoveredLink(link, this.options, documentUrl);
			return "error" in normalized ? [] : [normalized];
		});
	}

	async admitNormalizedDiscoveredLinks(
		parent: QueueItem,
		links: NormalizedDiscoveredLink[],
		signal?: AbortSignal,
	): Promise<LinkAdmissionResult[]> {
		const rejected = (reason: AdmissionRejectionReason, url: string): LinkAdmissionResult => ({
			type: "rejected",
			reason,
			url,
		});
		if (parent.depth >= this.options.crawlDepth) {
			return links.map((link) => rejected("depth-limit", link.link.url));
		}

		const robotsContext = {
			options: this.options,
			state: this.state,
			robotsService: this.robotsService,
		};
		const results: LinkAdmissionResult[] = [];
		for (const normalized of links) {
			signal?.throwIfAborted();
			const url = normalized.link.url;
			if (normalized.link.nofollow) {
				results.push(rejected("nofollow", url));
				continue;
			}
			if (this.state.remainingAdmissionCapacity() === 0) {
				results.push(rejected("queue-rejected", url));
				continue;
			}

			const robots = await evaluateRobotsGate(robotsContext, normalized.identity, signal);
			if (robots.type === "blocked" || robots.type === "disallowed") {
				results.push(
					rejected(robots.type === "blocked" ? "outbound-policy" : "robots-disallowed", url),
				);
				continue;
			}

			const item: QueueAdmission = {
				url: normalized.identity.canonicalUrl,
				domain: normalized.identity.domainBudgetKey,
				depth: parent.depth + 1,
				retries: 0,
				parentUrl: parent.url,
			};
			results.push(
				this.queue.enqueueNormalized(item)
					? { type: "admitted", item, link: normalized }
					: rejected("queue-rejected", item.url),
			);
		}

		return results;
	}
}

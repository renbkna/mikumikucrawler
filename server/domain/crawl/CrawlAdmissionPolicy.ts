import type { CrawlOptions } from "../../../shared/contracts/index.js";
import type { ExtractedLink } from "../../../shared/types.js";
import type { CrawlQueue, QueueItem } from "./CrawlQueue.js";
import type { CrawlState } from "./CrawlState.js";
import type { RobotsService } from "./RobotsService.js";
import {
	type NormalizedDiscoveredLink,
	type UrlRejectionReason,
	normalizeDiscoveredLink,
} from "./UrlPolicy.js";

export type AdmissionRejectionReason =
	| UrlRejectionReason
	| "depth-limit"
	| "nofollow"
	| "robots-disallowed"
	| "queue-rejected";

export type LinkAdmissionResult =
	| {
			type: "admitted";
			item: QueueItem;
			link: NormalizedDiscoveredLink;
	  }
	| {
			type: "rejected";
			reason: AdmissionRejectionReason;
			url: string;
	  };

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new Error("Link admission aborted");
}

export class CrawlAdmissionPolicy {
	constructor(
		private readonly options: CrawlOptions,
		private readonly state: CrawlState,
		private readonly queue: CrawlQueue,
		private readonly robotsService: RobotsService,
	) {}

	normalizeDiscoveredLinks(
		parent: QueueItem,
		links: ExtractedLink[],
	): NormalizedDiscoveredLink[] {
		return links.flatMap((link) => {
			const normalized = normalizeDiscoveredLink(
				link,
				this.options,
				parent.url,
			);
			return "error" in normalized ? [] : [normalized];
		});
	}

	async admitDiscoveredLinks(
		parent: QueueItem,
		links: ExtractedLink[],
		signal?: AbortSignal,
	): Promise<LinkAdmissionResult[]> {
		if (parent.depth >= this.options.crawlDepth) {
			return links.map((link) => ({
				type: "rejected",
				reason: "depth-limit",
				url: link.url,
			}));
		}

		const results: LinkAdmissionResult[] = [];
		for (const link of links) {
			throwIfAborted(signal);
			const normalized = normalizeDiscoveredLink(
				link,
				this.options,
				parent.url,
			);
			if ("error" in normalized) {
				results.push({
					type: "rejected",
					reason: normalized.reason,
					url: link.url,
				});
				continue;
			}

			if (normalized.link.nofollow) {
				results.push({
					type: "rejected",
					reason: "nofollow",
					url: normalized.link.url,
				});
				continue;
			}

			if (this.options.respectRobots) {
				const linkPolicy = await this.robotsService.evaluateIdentity(
					normalized.identity,
					signal,
				);
				if (!linkPolicy.allowed) {
					results.push({
						type: "rejected",
						reason: "robots-disallowed",
						url: normalized.link.url,
					});
					continue;
				}

				if (linkPolicy.crawlDelayMs !== undefined) {
					this.state.setDomainDelay(
						linkPolicy.delayKey,
						linkPolicy.crawlDelayMs,
					);
				}
			}

			const item: QueueItem = {
				url: normalized.identity.canonicalUrl,
				domain: normalized.identity.domainBudgetKey,
				depth: parent.depth + 1,
				retries: 0,
				parentUrl: parent.url,
			};
			if (!this.queue.enqueueNormalized(item)) {
				results.push({
					type: "rejected",
					reason: "queue-rejected",
					url: item.url,
				});
				continue;
			}

			results.push({
				type: "admitted",
				item,
				link: normalized,
			});
		}

		return results;
	}
}

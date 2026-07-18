import type { CrawlOptions } from "../../../shared/contracts/index.js";
import type { ExtractedLink } from "../../../shared/types.js";
import type { CrawlQueue, QueueItem } from "./CrawlQueue.js";
import type { CrawlState } from "./CrawlState.js";
import type { RobotsService } from "./RobotsService.js";
import { type NormalizedDiscoveredLink, normalizeDiscoveredLink } from "./UrlPolicy.js";

export type AdmissionRejectionReason =
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
		if (parent.depth >= this.options.crawlDepth) {
			return links.map((link) => ({
				type: "rejected",
				reason: "depth-limit",
				url: link.link.url,
			}));
		}

		const results: LinkAdmissionResult[] = [];
		for (const normalized of links) {
			throwIfAborted(signal);
			if (normalized.link.nofollow) {
				results.push({
					type: "rejected",
					reason: "nofollow",
					url: normalized.link.url,
				});
				continue;
			}

			if (this.options.respectRobots) {
				const linkPolicy = await this.robotsService.evaluateIdentity(normalized.identity, signal);
				if (linkPolicy.type === "disallowed") {
					results.push({
						type: "rejected",
						reason: "robots-disallowed",
						url: normalized.link.url,
					});
					continue;
				}

				if (linkPolicy.type !== "unavailable" && linkPolicy.crawlDelayMs !== undefined) {
					this.state.setDomainDelay(linkPolicy.delayKey, linkPolicy.crawlDelayMs);
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

import type { CrawlOptions } from "../../../shared/contracts/crawl.js";
import { normalizeHttpUrl } from "../../../shared/url.js";
import type { ExtractedLink } from "../../types.js";

const SKIPPED_EXTENSIONS =
	/\.(css|js|json|xml|txt|md|csv|svg|ico|git|gitignore)$/i;

export interface CrawlUrlIdentity {
	canonicalUrl: string;
	hostname: string;
	originKey: string;
	robotsKey: string;
	domainBudgetKey: string;
	skippedByExtension: boolean;
}

export type CrawlUrlIdentityResult = CrawlUrlIdentity | { error: string };

export function getCrawlUrlIdentity(url: string): CrawlUrlIdentityResult {
	const normalized = normalizeHttpUrl(url);
	if ("error" in normalized) {
		return normalized;
	}

	const parsed = new URL(normalized.url);
	const originKey = parsed.origin.toLowerCase();

	return {
		canonicalUrl: normalized.url,
		hostname: parsed.hostname,
		originKey,
		robotsKey: originKey,
		domainBudgetKey: parsed.hostname,
		skippedByExtension: SKIPPED_EXTENSIONS.test(parsed.pathname),
	};
}

export function classifyCrawlUrl(
	url: string,
	currentOriginKey: string,
): (CrawlUrlIdentity & { isInternal: boolean }) | { error: string } {
	const identity = getCrawlUrlIdentity(url);
	if ("error" in identity) {
		return identity;
	}

	return {
		...identity,
		isInternal: identity.originKey === currentOriginKey,
	};
}

function toCurrentOriginKey(currentUrlOrDomain: string): string {
	if (/^https?:\/\//i.test(currentUrlOrDomain)) {
		const identity = getCrawlUrlIdentity(currentUrlOrDomain);
		if (!("error" in identity)) {
			return identity.originKey;
		}
	}

	return `https://${currentUrlOrDomain.toLowerCase()}`;
}

export function filterDiscoveredLinks(
	links: ExtractedLink[],
	options: CrawlOptions,
	currentUrlOrDomain: string,
): ExtractedLink[] {
	const currentOriginKey = toCurrentOriginKey(currentUrlOrDomain);

	return links.flatMap((link) => {
		if (!link.url) {
			return [];
		}

		const identity = classifyCrawlUrl(link.url, currentOriginKey);
		if ("error" in identity || identity.skippedByExtension) {
			return [];
		}

		const isInternal = link.isInternal ?? identity.isInternal;
		if (options.crawlMethod !== "full" && !isInternal) {
			return [];
		}

		return [
			{
				...link,
				url: identity.canonicalUrl,
				domain: identity.domainBudgetKey,
				isInternal,
				nofollow: Boolean(link.nofollow),
			},
		];
	});
}

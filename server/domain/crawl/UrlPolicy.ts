import type { CrawlOptions } from "../../../shared/contracts/index.js";
import { normalizeHttpUrl } from "../../../shared/url.js";
import type { ExtractedLink } from "../../../shared/types.js";

const SKIPPED_EXTENSIONS =
	/\.(css|js|json|xml|txt|md|csv|svg|ico|git|gitignore)$/i;

export interface CrawlUrlIdentity {
	canonicalUrl: string;
	robotsMatchUrl: string;
	hostname: string;
	originKey: string;
	robotsKey: string;
	domainBudgetKey: string;
	skippedByExtension: boolean;
}

export type CrawlUrlIdentityResult = CrawlUrlIdentity | { error: string };

export type UrlRejectionReason =
	| "missing-url"
	| "invalid-url"
	| "resource-extension"
	| "external-link";

export type NormalizedDiscoveredLink = {
	link: ExtractedLink & {
		url: string;
		domain: string;
		isInternal: boolean;
		nofollow: boolean;
	};
	identity: CrawlUrlIdentity;
};

function toRobotsMatchUrl(url: string): string | { error: string } {
	let candidate = url.trim();
	const hasExplicitHttpScheme = /^https?:\/\//i.test(candidate);
	const hasSchemeLikePrefix = /^[a-z][a-z0-9+.-]*:/i.test(candidate);
	const looksLikeHostWithPort = /^[^/?#]+:\d/.test(candidate);

	if (hasSchemeLikePrefix && !hasExplicitHttpScheme && !looksLikeHostWithPort) {
		return { error: "Only HTTP and HTTPS URLs are supported" };
	}

	if (!hasExplicitHttpScheme) {
		candidate = `http://${candidate}`;
	}

	try {
		const parsed = new URL(candidate);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return { error: "Only HTTP and HTTPS URLs are supported" };
		}

		parsed.hostname = parsed.hostname.toLowerCase();
		if (
			(parsed.protocol === "http:" && parsed.port === "80") ||
			(parsed.protocol === "https:" && parsed.port === "443")
		) {
			parsed.port = "";
		}
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return { error: "Invalid URL format" };
	}
}

export function getCrawlUrlIdentity(url: string): CrawlUrlIdentityResult {
	const normalized = normalizeHttpUrl(url);
	if ("error" in normalized) {
		return normalized;
	}
	const robotsMatchUrl = toRobotsMatchUrl(url);
	if (typeof robotsMatchUrl !== "string") {
		return robotsMatchUrl;
	}

	const parsed = new URL(normalized.url);
	const originKey = parsed.origin.toLowerCase();

	return {
		canonicalUrl: normalized.url,
		robotsMatchUrl,
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
	return links.flatMap((link) => {
		const normalized = normalizeDiscoveredLink(
			link,
			options,
			currentUrlOrDomain,
		);
		return "error" in normalized ? [] : [normalized.link];
	});
}

export function normalizeDiscoveredLink(
	link: ExtractedLink,
	options: CrawlOptions,
	currentUrlOrDomain: string,
): NormalizedDiscoveredLink | { error: string; reason: UrlRejectionReason } {
	if (!link.url) {
		return { error: "Missing URL", reason: "missing-url" };
	}

	const currentOriginKey = toCurrentOriginKey(currentUrlOrDomain);
	const identity = classifyCrawlUrl(link.url, currentOriginKey);
	if ("error" in identity) {
		return { ...identity, reason: "invalid-url" };
	}

	if (identity.skippedByExtension) {
		return {
			error: "URL has a skipped resource extension",
			reason: "resource-extension",
		};
	}

	const isInternal = identity.isInternal;
	if (options.crawlMethod !== "full" && !isInternal) {
		return {
			error: "External links require full crawl mode",
			reason: "external-link",
		};
	}

	return {
		identity,
		link: {
			...link,
			url: identity.canonicalUrl,
			domain: identity.domainBudgetKey,
			isInternal,
			nofollow: Boolean(link.nofollow),
		},
	};
}

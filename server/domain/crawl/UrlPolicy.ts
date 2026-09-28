import type { CrawlOptions } from "../../../shared/contracts/index.js";
import { normalizeCanonicalHttpUrl, publicHostnameError } from "../../../shared/url.js";
import type { ExtractedLink } from "../../types.js";

const SKIPPED_EXTENSIONS =
	/\.(7z|apk|appimage|bz2|csv|css|deb|dmg|exe|git|gitignore|gz|ico|iso|js|md|msi|msix|pkg|rar|rpm|svg|tar|tgz|txt|xml|xz|zip|zst)$/i;

export interface CrawlUrlIdentity {
	canonicalUrl: string;
	hostname: string;
	originKey: string;
	domainBudgetKey: string;
	skippedByExtension: boolean;
}

export type CrawlUrlIdentityResult = CrawlUrlIdentity | { error: string };

export type UrlRejectionReason =
	| "missing-url"
	| "invalid-url"
	| "resource-extension"
	| "external-link"
	| "ssrf-blocked";

export type NormalizedDiscoveredLink = {
	link: { url: string; nofollow: boolean };
	identity: CrawlUrlIdentity;
};

export function getCrawlUrlIdentity(url: string): CrawlUrlIdentityResult {
	const normalized = normalizeCanonicalHttpUrl(url);
	if ("error" in normalized) {
		return normalized;
	}
	const parsed = new URL(normalized.url);
	const originKey = parsed.origin;

	return {
		canonicalUrl: normalized.url,
		hostname: parsed.hostname,
		originKey,
		domainBudgetKey: parsed.hostname,
		skippedByExtension: SKIPPED_EXTENSIONS.test(parsed.pathname),
	};
}

/** True when `domain` is exactly the budget key a crawl URL on that host would carry. */
export function isCanonicalDomainBudgetKey(domain: string): boolean {
	const identity = getCrawlUrlIdentity(`http://${domain}/`);
	return !("error" in identity) && identity.domainBudgetKey === domain;
}

export function normalizeDiscoveredLink(
	link: ExtractedLink,
	options: CrawlOptions,
	documentUrl: string,
): NormalizedDiscoveredLink | { error: string; reason: UrlRejectionReason } {
	if (!link.url) {
		return { error: "Missing URL", reason: "missing-url" };
	}

	const currentIdentity = getCrawlUrlIdentity(documentUrl);
	if ("error" in currentIdentity) {
		return { error: "Invalid document URL", reason: "invalid-url" };
	}

	const identity = getCrawlUrlIdentity(link.url);
	if ("error" in identity) {
		return { ...identity, reason: "invalid-url" };
	}

	const hostError = publicHostnameError(identity.hostname);
	if (hostError !== null) {
		return { error: hostError, reason: "ssrf-blocked" };
	}

	if (identity.skippedByExtension) {
		return {
			error: "URL has a skipped resource extension",
			reason: "resource-extension",
		};
	}

	const isInternal = identity.originKey === currentIdentity.originKey;
	if (options.crawlMethod !== "full" && !isInternal) {
		return {
			error: "External links require full crawl mode",
			reason: "external-link",
		};
	}

	return {
		identity,
		link: {
			url: identity.canonicalUrl,
			nofollow: Boolean(link.nofollow),
		},
	};
}

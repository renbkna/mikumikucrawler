import type { CrawlOptions } from "../../contracts/crawl.js";
import type { ExtractedLink } from "../../types.js";

const SKIPPED_EXTENSIONS =
	/\.(css|js|json|xml|txt|md|csv|svg|ico|git|gitignore)$/i;

export function filterDiscoveredLinks(
	links: ExtractedLink[],
	options: CrawlOptions,
	currentDomain: string,
): ExtractedLink[] {
	return links
		.filter((link) => {
			if (!link.url?.startsWith("http")) {
				return false;
			}

			if (SKIPPED_EXTENSIONS.test(link.url)) {
				return false;
			}

			const isInternal = link.isInternal ?? link.domain === currentDomain;
			if (options.crawlMethod !== "full" && !isInternal) {
				return false;
			}

			return true;
		})
		.map((link) => ({
			...link,
			isInternal: link.isInternal ?? link.domain === currentDomain,
			nofollow: Boolean(link.nofollow),
		}));
}

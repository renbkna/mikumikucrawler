import type { CheerioAPI } from "cheerio";
import type { SanitizedCrawlOptions } from "../../types.js";
import { normalizeUrl } from "../../utils/helpers.js";

const SKIP_EXTENSIONS =
	/\.(css|js|json|xml|txt|md|csv|svg|ico|git|gitignore)$/i;

interface ExtractedLink {
	url: string;
	text: string;
	isInternal: boolean;
}

export function extractLinks(
	$: CheerioAPI,
	baseUrl: string,
	options: SanitizedCrawlOptions,
): ExtractedLink[] {
	const baseHost = new URL(baseUrl).hostname;
	const seen = new Set<string>();
	const result: ExtractedLink[] = [];

	$("a").each((_: number, el) => {
		const href = $(el as unknown as string).attr("href");
		if (!href) return;

		try {
			const url = new URL(href, baseUrl);
			const normalized = normalizeUrl(url.href);
			if ("error" in normalized || !normalized.url) return;
			const normalizedUrl = normalized.url;

			if (seen.has(normalizedUrl)) return;
			seen.add(normalizedUrl);

			if (url.protocol !== "http:" && url.protocol !== "https:") return;
			if (options.crawlMethod !== "full" && url.hostname !== baseHost) return;

			if (SKIP_EXTENSIONS.test(url.pathname)) return;

			result.push({
				url: normalizedUrl,
				text: $(el as unknown as string)
					.text()
					.trim(),
				isInternal: url.hostname === baseHost,
			});
		} catch {}
	});

	if (options.crawlMethod === "media" || options.crawlMethod === "full") {
		$("img, video, audio, source").each((_: number, el) => {
			const src = $(el as unknown as string).attr("src");
			if (!src) return;

			try {
				const url = new URL(src, baseUrl);
				const normalized = normalizeUrl(url.href);
				if ("error" in normalized || !normalized.url) return;
				const normalizedUrl = normalized.url;

				if (seen.has(normalizedUrl)) return;
				seen.add(normalizedUrl);

				if (url.protocol !== "http:" && url.protocol !== "https:") return;

				result.push({
					url: normalizedUrl,
					text: $(el as unknown as string).attr("alt") || "",
					isInternal: url.hostname === baseHost,
				});
			} catch {}
		});
	}

	return result;
}

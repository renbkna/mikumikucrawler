import * as cheerio from "cheerio";
import type { Logger } from "../config/logging.js";
import { FETCH_HEADERS, SITEMAP_CONSTANTS } from "../constants.js";
import type { SitemapEntry } from "../types.js";
import { getErrorMessage } from "./helpers.js";
import { secureFetch } from "./secureFetch.js";

type SecureFetchFn = typeof secureFetch;

/**
 * Fetches a URL and returns the response text.
 * Returns null on any error — sitemap discovery is best-effort and must not abort a crawl.
 */
async function fetchXml(
	url: string,
	secureFetchFn: SecureFetchFn,
): Promise<string | null> {
	try {
		const response = await secureFetchFn({
			url,
			headers: { ...FETCH_HEADERS, Accept: "application/xml,text/xml,*/*" },
			signal: AbortSignal.timeout(SITEMAP_CONSTANTS.FETCH_TIMEOUT_MS),
			redirect: "follow",
		});
		if (!response.ok) return null;
		return await response.text();
	} catch {
		return null;
	}
}

/**
 * Parses a sitemap index XML body and returns the child sitemap URLs.
 */
function parseSitemapIndex(xml: string): string[] {
	const $ = cheerio.load(xml, { xmlMode: true });
	const locs: string[] = [];
	$("sitemap > loc").each((_, el) => {
		const url = $(el).text().trim();
		if (url) locs.push(url);
	});
	return locs;
}

/**
 * Parses a urlset sitemap XML body and returns the entries.
 */
function parseUrlset(xml: string): SitemapEntry[] {
	const $ = cheerio.load(xml, { xmlMode: true });
	const entries: SitemapEntry[] = [];

	$("url").each((_, el) => {
		const url = $("loc", el).first().text().trim();
		if (!url) return;

		const lastmod = $("lastmod", el).first().text().trim() || undefined;
		const changefreq = $("changefreq", el).first().text().trim() || undefined;
		const rawPriority = $("priority", el).first().text().trim();
		const priority = rawPriority ? Number.parseFloat(rawPriority) : undefined;

		entries.push({
			url,
			lastmod,
			priority:
				priority !== undefined && Number.isFinite(priority)
					? priority
					: undefined,
			changefreq,
		});
	});

	return entries;
}

/**
 * Recursively fetches and parses sitemaps, following sitemap index references up to
 * SITEMAP_CONSTANTS.MAX_RECURSION_DEPTH levels deep.
 *
 * @param url - The sitemap URL to fetch
 * @param collected - Mutable set of already-seen URLs (deduplication)
 * @param entries - Mutable array accumulating discovered entries
 * @param depth - Current recursion depth
 * @param logger - Logger instance
 */
async function crawlSitemap(
	url: string,
	collected: Set<string>,
	entries: SitemapEntry[],
	depth: number,
	logger: Logger,
	secureFetchFn: SecureFetchFn,
): Promise<void> {
	if (depth > SITEMAP_CONSTANTS.MAX_RECURSION_DEPTH) return;
	if (entries.length >= SITEMAP_CONSTANTS.MAX_ENTRIES) return;

	const xml = await fetchXml(url, secureFetchFn);
	if (!xml) return;

	// Detect whether this is a sitemap index or a urlset
	const isSitemapIndex =
		xml.includes("<sitemapindex") || xml.includes("<SitemapIndex");

	if (isSitemapIndex) {
		const childUrls = parseSitemapIndex(xml);
		logger.debug(
			`[Sitemap] Index at ${url} references ${childUrls.length} sitemaps`,
		);

		for (const childUrl of childUrls) {
			if (entries.length >= SITEMAP_CONSTANTS.MAX_ENTRIES) break;
			if (!collected.has(childUrl)) {
				collected.add(childUrl);
				await crawlSitemap(
					childUrl,
					collected,
					entries,
					depth + 1,
					logger,
					secureFetchFn,
				);
			}
		}
	} else {
		const newEntries = parseUrlset(xml);
		for (const entry of newEntries) {
			if (entries.length >= SITEMAP_CONSTANTS.MAX_ENTRIES) break;
			if (!collected.has(entry.url)) {
				collected.add(entry.url);
				entries.push(entry);
			}
		}
		logger.debug(`[Sitemap] ${url} yielded ${newEntries.length} URLs`);
	}
}

/**
 * Discovers and parses the sitemap for a given base URL.
 *
 * Discovery order:
 * 1. Check robots.txt for a `Sitemap:` directive
 * 2. Try `/sitemap_index.xml`
 * 3. Fall back to `/sitemap.xml`
 *
 * Fails silently — sitemap discovery is optional and must never abort a crawl.
 * Returns a deduplicated list sorted by priority descending (highest priority first).
 *
 * @param baseUrl - The crawl target root URL (e.g. "https://example.com")
 * @param logger - Logger instance for debug/info output
 */
export async function fetchSitemap(
	baseUrl: string,
	logger: Logger,
	secureFetchFn: SecureFetchFn = secureFetch,
): Promise<SitemapEntry[]> {
	try {
		const origin = new URL(baseUrl).origin;
		const entries: SitemapEntry[] = [];
		const collected = new Set<string>();
		const candidateUrls: string[] = [];

		// 1. Check robots.txt for Sitemap: directive
		try {
			const robotsText = await fetchXml(`${origin}/robots.txt`, secureFetchFn);
			if (robotsText) {
				for (const line of robotsText.split("\n")) {
					const match = /^Sitemap:\s*(.+)$/i.exec(line.trim());
					if (match?.[1]) {
						const sitemapUrl = match[1].trim();
						if (!collected.has(sitemapUrl)) {
							collected.add(sitemapUrl);
							candidateUrls.push(sitemapUrl);
						}
					}
				}
			}
		} catch {
			// robots.txt fetch failure is non-fatal
		}

		// 2. Always add standard paths as fallbacks (deduplication handles overlaps)
		for (const path of ["/sitemap_index.xml", "/sitemap.xml"]) {
			const url = `${origin}${path}`;
			if (!collected.has(url)) {
				collected.add(url);
				candidateUrls.push(url);
			}
		}

		// Reset collected to only track *entry* URLs, not candidate sitemap URLs
		collected.clear();

		// Crawl each candidate sitemap
		for (const candidateUrl of candidateUrls) {
			if (entries.length >= SITEMAP_CONSTANTS.MAX_ENTRIES) break;
			await crawlSitemap(
				candidateUrl,
				collected,
				entries,
				0,
				logger,
				secureFetchFn,
			);
		}

		if (entries.length === 0) return [];

		// Sort by priority descending so high-priority pages are crawled first
		entries.sort((a, b) => (b.priority ?? 0.5) - (a.priority ?? 0.5));

		logger.info(`[Sitemap] Discovered ${entries.length} URLs for ${origin}`);
		return entries;
	} catch (err) {
		// Sitemap parsing failures must never abort a crawl
		logger.debug(`[Sitemap] Failed to fetch sitemap: ${getErrorMessage(err)}`);
		return [];
	}
}

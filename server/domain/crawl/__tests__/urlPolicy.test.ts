import { describe, expect, test } from "bun:test";
import type { CrawlOptions } from "../../../contracts/crawl.js";
import { filterDiscoveredLinks } from "../UrlPolicy.js";

/**
 * CONTRACT: filterDiscoveredLinks
 *
 * Input: (links: ExtractedLink[], options: CrawlOptions, currentDomain: string)
 * Output: filtered ExtractedLink[] with normalized isInternal and nofollow fields
 *
 * Filtering rules:
 *   1. Rejects non-http URLs
 *   2. Rejects resource extensions (.css, .js, .json, .xml, .txt, .md, .csv, .svg, .ico, .git, .gitignore)
 *   3. Rejects external links unless crawlMethod is "full"
 *   4. Sets isInternal based on domain match when not already set
 *   5. Coerces nofollow to boolean
 */

function makeOptions(overrides: Partial<CrawlOptions> = {}): CrawlOptions {
	return {
		target: "https://example.com",
		crawlMethod: "links",
		crawlDepth: 2,
		crawlDelay: 200,
		maxPages: 10,
		maxPagesPerDomain: 0,
		maxConcurrentRequests: 1,
		retryLimit: 0,
		dynamic: false,
		respectRobots: false,
		contentOnly: false,
		saveMedia: false,
		...overrides,
	};
}

describe("filterDiscoveredLinks", () => {
	test("rejects non-http URLs", () => {
		const result = filterDiscoveredLinks(
			[
				{ url: "mailto:test@example.com", domain: "example.com" },
				{ url: "javascript:void(0)", domain: "example.com" },
				{ url: "ftp://files.example.com", domain: "example.com" },
				{ url: "https://example.com/page", domain: "example.com" },
			],
			makeOptions(),
			"example.com",
		);

		expect(result).toHaveLength(1);
		expect(result[0].url).toBe("https://example.com/page");
	});

	test("rejects resource extensions", () => {
		const extensions = [
			".css",
			".js",
			".json",
			".xml",
			".txt",
			".md",
			".csv",
			".svg",
			".ico",
		];
		const links = extensions.map((ext) => ({
			url: `https://example.com/file${ext}`,
			domain: "example.com",
		}));
		links.push({
			url: "https://example.com/page",
			domain: "example.com",
		});

		const result = filterDiscoveredLinks(links, makeOptions(), "example.com");

		expect(result).toHaveLength(1);
		expect(result[0].url).toBe("https://example.com/page");
	});

	test("blocks external links when crawlMethod is 'links'", () => {
		const result = filterDiscoveredLinks(
			[
				{
					url: "https://external.com/page",
					domain: "external.com",
					isInternal: false,
				},
				{
					url: "https://example.com/about",
					domain: "example.com",
					isInternal: true,
				},
			],
			makeOptions({ crawlMethod: "links" }),
			"example.com",
		);

		expect(result).toHaveLength(1);
		expect(result[0].url).toBe("https://example.com/about");
	});

	test("allows external links when crawlMethod is 'full'", () => {
		const result = filterDiscoveredLinks(
			[
				{
					url: "https://external.com/page",
					domain: "external.com",
					isInternal: false,
				},
				{
					url: "https://example.com/about",
					domain: "example.com",
					isInternal: true,
				},
			],
			makeOptions({ crawlMethod: "full" }),
			"example.com",
		);

		expect(result).toHaveLength(2);
	});

	test("infers isInternal from domain match when not set", () => {
		const result = filterDiscoveredLinks(
			[
				{ url: "https://example.com/page", domain: "example.com" },
				{ url: "https://other.com/page", domain: "other.com" },
			],
			makeOptions({ crawlMethod: "full" }),
			"example.com",
		);

		expect(result[0].isInternal).toBe(true);
		expect(result[1].isInternal).toBe(false);
	});

	test("coerces nofollow to boolean", () => {
		const result = filterDiscoveredLinks(
			[
				{
					url: "https://example.com/a",
					domain: "example.com",
					nofollow: undefined,
				},
				{
					url: "https://example.com/b",
					domain: "example.com",
					nofollow: true,
				},
			],
			makeOptions(),
			"example.com",
		);

		expect(result[0].nofollow).toBe(false);
		expect(result[1].nofollow).toBe(true);
	});
});

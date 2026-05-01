import { describe, expect, test } from "bun:test";
import { NativeRobotsParser } from "../robotsParser.js";

describe("NativeRobotsParser", () => {
	describe("basic parsing", () => {
		test("parses empty robots.txt", () => {
			const parser = new NativeRobotsParser("");

			expect(parser.isAllowed("/any/path")).toBe(true);
			expect(parser.getSitemaps()).toEqual([]);
		});

		test("parses simple disallow rule", () => {
			const robotsTxt = `
User-agent: *
Disallow: /private/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/public/page")).toBe(true);
			expect(parser.isAllowed("/private/secret")).toBe(false);
		});

		test("empty disallow means allow all", () => {
			const robotsTxt = `
User-agent: *
Disallow:
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/public/page")).toBe(true);
			expect(parser.isAllowed("/private/secret")).toBe(true);
		});

		test("parses simple allow rule", () => {
			const robotsTxt = `
User-agent: *
Disallow: /
Allow: /public/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/public/page")).toBe(true);
			expect(parser.isAllowed("/private/secret")).toBe(false);
		});
	});

	describe("user-agent matching", () => {
		test("matches exact user-agent", () => {
			const robotsTxt = `
User-agent: Googlebot
Disallow: /google-only/

User-agent: Bingbot
Disallow: /bing-only/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/google-only/page", "Googlebot")).toBe(false);
			expect(parser.isAllowed("/bing-only/page", "Googlebot")).toBe(true);
			expect(parser.isAllowed("/bing-only/page", "Bingbot")).toBe(false);
		});

		test("applies shared rules to grouped user-agent lines", () => {
			const robotsTxt = `
User-agent: Googlebot
User-agent: Bingbot
Disallow: /shared/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/shared/page", "Googlebot")).toBe(false);
			expect(parser.isAllowed("/shared/page", "Bingbot")).toBe(false);
			expect(parser.isAllowed("/shared/page", "OtherBot")).toBe(true);
		});

		test("combines split groups for the same user-agent", () => {
			const robotsTxt = `
User-agent: MyBot
Allow: /public/

User-agent: MyBot
Disallow: /private/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/public/page", "MyBot")).toBe(true);
			expect(parser.isAllowed("/private/page", "MyBot")).toBe(false);
		});

		test("ignored group directives still separate following user-agent groups", () => {
			const emptyDisallow = new NativeRobotsParser(`
User-agent: *
Disallow:
User-agent: BadBot
Disallow: /private
			`);

			expect(emptyDisallow.isAllowed("/private/page", "AnyBot")).toBe(true);
			expect(emptyDisallow.isAllowed("/private/page", "BadBot")).toBe(false);

			const invalidCrawlDelay = new NativeRobotsParser(`
User-agent: *
Crawl-delay: eventually
User-agent: BadBot
Disallow: /private
			`);

			expect(invalidCrawlDelay.isAllowed("/private/page", "AnyBot")).toBe(true);
			expect(invalidCrawlDelay.isAllowed("/private/page", "BadBot")).toBe(
				false,
			);
		});

		test("matches wildcard user-agent", () => {
			const robotsTxt = `
User-agent: *
Disallow: /everyone/

User-agent: SpecialBot
Disallow: /special/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/everyone/page", "AnyBot")).toBe(false);
			expect(parser.isAllowed("/special/page", "AnyBot")).toBe(true);
			expect(parser.isAllowed("/special/page", "SpecialBot")).toBe(false);
		});

		test("matches partial user-agent (substring)", () => {
			const robotsTxt = `
User-agent: Google
Disallow: /google-rules/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/google-rules/page", "Googlebot")).toBe(false);
			expect(parser.isAllowed("/google-rules/page", "OtherBot")).toBe(true);
		});

		test("falls back to wildcard when specific UA not found", () => {
			const robotsTxt = `
User-agent: *
Disallow: /global/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/global/page", "UnknownBot")).toBe(false);
		});
	});

	describe("wildcard patterns", () => {
		test("handles * wildcard in path", () => {
			const robotsTxt = `
User-agent: *
Disallow: /secret/*
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/secret/")).toBe(false);
			expect(parser.isAllowed("/secret/anything")).toBe(false);
			expect(parser.isAllowed("/secret/deep/nested")).toBe(false);
			expect(parser.isAllowed("/public/page")).toBe(true);
		});

		test("handles * in middle of pattern", () => {
			const robotsTxt = `
User-agent: *
Disallow: /*/admin/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/foo/admin/page")).toBe(false);
			expect(parser.isAllowed("/bar/admin/")).toBe(false);
			expect(parser.isAllowed("/admin/page")).toBe(true);
		});
	});

	describe("end-of-string anchor ($)", () => {
		test("handles $ anchor", () => {
			const robotsTxt = `
User-agent: *
Disallow: /*.pdf$
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/document.pdf")).toBe(false);
			expect(parser.isAllowed("/document.pdf?query")).toBe(true);
			expect(parser.isAllowed("/document.html")).toBe(true);
		});

		test("matches full URL paths with query strings for $ anchor rules", () => {
			const robotsTxt = `
User-agent: *
Disallow: /*.pdf$
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("https://example.com/document.pdf")).toBe(false);
			expect(parser.isAllowed("https://example.com/document.pdf?query")).toBe(
				true,
			);
		});
	});

	describe("query string patterns", () => {
		test("treats query delimiters as literals in robots patterns", () => {
			const parser = new NativeRobotsParser(`
User-agent: *
Disallow: /search?sort=
			`);

			expect(parser.isAllowed("https://example.com/search?sort=asc")).toBe(
				false,
			);
			expect(parser.isAllowed("https://example.com/searchxsort=asc")).toBe(
				true,
			);
		});

		test("query-string allow rules participate in longest-match precedence", () => {
			const parser = new NativeRobotsParser(`
User-agent: *
Disallow: /
Allow: /search?sort=
			`);

			expect(parser.isAllowed("https://example.com/search?sort=asc")).toBe(
				true,
			);
			expect(parser.isAllowed("https://example.com/other")).toBe(false);
		});
	});

	describe("longest match precedence (RFC 9309)", () => {
		test("longer allow beats shorter disallow", () => {
			const robotsTxt = `
User-agent: *
Disallow: /
Allow: /public
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/public")).toBe(true);
			expect(parser.isAllowed("/private")).toBe(false);
		});

		test("longer pattern wins regardless of type", () => {
			const robotsTxt = `
User-agent: *
Allow: /public/files/
Disallow: /public/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/public/files/doc.pdf")).toBe(true);
			expect(parser.isAllowed("/public/other/")).toBe(false);
		});

		test("allow wins on tie", () => {
			const robotsTxt = `
User-agent: *
Disallow: /page
Allow: /page
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/page")).toBe(true);
		});
	});

	describe("none shorthand", () => {
		test("none means noindex and nofollow", () => {
			const robotsTxt = `
User-agent: *
Disallow: /none/
Disallow: /some/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/none/page")).toBe(false);
			expect(parser.isAllowed("/some/page")).toBe(false);
		});
	});

	describe("crawl delay", () => {
		test("parses crawl-delay directive", () => {
			const robotsTxt = `
User-agent: *
Crawl-delay: 10
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.getCrawlDelay()).toBe(10);
		});

		test("preserves explicit zero crawl-delay", () => {
			const robotsTxt = `
User-agent: *
Crawl-delay: 0
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.getCrawlDelay()).toBe(0);
		});

		test("returns undefined when no crawl-delay", () => {
			const robotsTxt = `
User-agent: *
Disallow: /private/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.getCrawlDelay()).toBeUndefined();
		});

		test("ignores invalid crawl-delay values", () => {
			for (const value of ["eventually", "-1"]) {
				const parser = new NativeRobotsParser(`
User-agent: *
Crawl-delay: ${value}
				`);

				expect(parser.getCrawlDelay()).toBeUndefined();
			}
		});

		test("returns crawl-delay for specific user-agent", () => {
			const robotsTxt = `
User-agent: SlowBot
Crawl-delay: 30

User-agent: *
Crawl-delay: 5
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.getCrawlDelay("SlowBot")).toBe(30);
			expect(parser.getCrawlDelay("OtherBot")).toBe(5);
		});
	});

	describe("sitemaps", () => {
		test("parses sitemap directives", () => {
			const robotsTxt = `
Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/sitemap2.xml
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			const sitemaps = parser.getSitemaps();
			expect(sitemaps).toHaveLength(2);
			expect(sitemaps).toContain("https://example.com/sitemap.xml");
			expect(sitemaps).toContain("https://example.com/sitemap2.xml");
		});

		test("returns empty array when no sitemaps", () => {
			const parser = new NativeRobotsParser("");
			expect(parser.getSitemaps()).toEqual([]);
		});
	});

	describe("comments", () => {
		test("ignores standalone comment lines", () => {
			const robotsTxt = `
# This is a comment
User-agent: *
# Another comment
Disallow: /private/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/private/page")).toBe(false);
		});

		test("inline content after directive is NOT treated as comment (per RFC 9309)", () => {
			const robotsTxt = `
User-agent: *
Disallow: /private/ extra
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/private/ extra")).toBe(false);
		});
	});

	describe("malformed input", () => {
		test("handles invalid lines gracefully", () => {
			const robotsTxt = `
This is not valid
User-agent: *
Disallow: /private/
Another invalid line
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/private/page")).toBe(false);
		});

		test("handles lines without colons", () => {
			const robotsTxt = `
User-agent: *
This has no colon
Disallow: /private/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/private/page")).toBe(false);
		});
	});

	describe("URL handling", () => {
		test("accepts full URLs", () => {
			const robotsTxt = `
User-agent: *
Disallow: /private/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("https://example.com/public/page")).toBe(true);
			expect(parser.isAllowed("https://example.com/private/page")).toBe(false);
		});

		test("isDisallowed is inverse of isAllowed", () => {
			const robotsTxt = `
User-agent: *
Disallow: /private/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isDisallowed("/public/page")).toBe(false);
			expect(parser.isDisallowed("/private/page")).toBe(true);
		});
	});

	describe("case sensitivity", () => {
		test("directives are case-insensitive", () => {
			const robotsTxt = `
USER-AGENT: *
DISALLOW: /private/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/private/page")).toBe(false);
		});

		test("paths are case-sensitive per RFC 9309", () => {
			const robotsTxt = `
User-agent: *
Disallow: /Private/
			`.trim();

			const parser = new NativeRobotsParser(robotsTxt);

			expect(parser.isAllowed("/Private/page")).toBe(false);
			expect(parser.isAllowed("/private/page")).toBe(true);
		});
	});
});

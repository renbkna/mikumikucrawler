import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";
import { SITE_COOKIES, SITE_SELECTORS } from "../../constants.js";

/**
 * CONTRACT: Site Configuration
 *
 * Purpose: Configuration for site-specific selectors and cookies to handle
 * complex JavaScript-heavy sites and bypass consent dialogs.
 *
 * SITE_SELECTORS:
 *   - Key: URL pattern (substring match)
 *   - Value: CSS selector to wait for content load
 *   - Used by: DynamicRenderer to detect when SPA content is ready
 *
 * SITE_COOKIES:
 *   - Key: URL pattern (substring match)
 *   - Value: Array of { name, value } cookies to set
 *   - Used by: DynamicRenderer to bypass consent dialogs
 *
 * INVARIANTS:
 *   1. SELECTOR VALIDITY: All selectors are valid CSS selectors
 *   2. MATCHING: First matching pattern wins (order matters)
 *   3. COOKIE FORMAT: name and value are non-empty strings
 *   4. URL PATTERNS: Substring matching (not regex)
 *   5. FALLBACK: Unknown sites return undefined
 *
 * EDGE CASES:
 *   - Multiple patterns match same URL
 *   - Subdomain variations
 *   - URL with query strings
 *   - Selectors on pages without target elements
 *   - Cookie conflicts
 */

describe("SITE_SELECTORS CONTRACT", () => {
	describe("INVARIANT: Pattern Matching", () => {
		test("matches YouTube watch URLs", () => {
			const url = "https://www.youtube.com/watch?v=abc123";
			const selector = Object.entries(SITE_SELECTORS).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			expect(selector).toBe("h1.ytd-video-primary-info-renderer");
		});

		test("matches Twitter/X URLs", () => {
			const twitterUrl = "https://twitter.com/user/status/123";
			const xUrl = "https://x.com/user/status/123";

			const twitterSelector = Object.entries(SITE_SELECTORS).find(([pattern]) =>
				twitterUrl.includes(pattern),
			)?.[1];
			const xSelector = Object.entries(SITE_SELECTORS).find(([pattern]) =>
				xUrl.includes(pattern),
			)?.[1];

			expect(twitterSelector).toBe('[data-testid="tweet"]');
			expect(xSelector).toBe('[data-testid="tweet"]');
		});

		test("matches GitHub repository URLs", () => {
			const url = "https://github.com/user/repo";
			const selector = Object.entries(SITE_SELECTORS).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			expect(selector).toBe(".js-repo-root, .repository-content");
		});

		test("matches Reddit URLs", () => {
			const url = "https://www.reddit.com/r/programming/comments/abc123";
			const selector = Object.entries(SITE_SELECTORS).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			expect(selector).toBe('[data-testid="post-container"]');
		});

		test("matches LinkedIn URLs", () => {
			const url = "https://www.linkedin.com/feed/";
			const selector = Object.entries(SITE_SELECTORS).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			expect(selector).toBe(".feed-container-theme");
		});

		test("matches Instagram URLs", () => {
			const url = "https://www.instagram.com/p/abc123/";
			const selector = Object.entries(SITE_SELECTORS).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			expect(selector).toBe('[role="main"]');
		});

		test("matches Facebook URLs", () => {
			const url = "https://www.facebook.com/groups/test";
			const selector = Object.entries(SITE_SELECTORS).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			expect(selector).toBe('[role="main"]');
		});

		test("matches Medium URLs", () => {
			const url = "https://medium.com/@user/article-slug";
			const selector = Object.entries(SITE_SELECTORS).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			expect(selector).toBe("article");
		});

		test("matches StackOverflow URLs", () => {
			const url = "https://stackoverflow.com/questions/123/test";
			const selector = Object.entries(SITE_SELECTORS).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			expect(selector).toBe(".question, .answer");
		});

		test("returns undefined for unknown URLs", () => {
			const url = "https://unknown-site.com/page";
			const selector = Object.entries(SITE_SELECTORS).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			expect(selector).toBeUndefined();
		});

		test("handles URLs with query strings", () => {
			const url = "https://www.youtube.com/watch?v=abc123&feature=share";
			const selector = Object.entries(SITE_SELECTORS).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			expect(selector).toBe("h1.ytd-video-primary-info-renderer");
		});

		test("handles URLs with fragments", () => {
			const url = "https://github.com/user/repo#readme";
			const selector = Object.entries(SITE_SELECTORS).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			expect(selector).toBe(".js-repo-root, .repository-content");
		});

		test("first matching pattern wins", () => {
			// youtube.com/watch should match before youtube.com/@
			const url = "https://www.youtube.com/watch?v=abc123";
			const entries = Object.entries(SITE_SELECTORS);

			const matches = entries.filter(([pattern]) => url.includes(pattern));

			// Should match youtube.com/watch pattern first
			expect(matches.length).toBeGreaterThanOrEqual(1);
			expect(matches[0][0]).toBe("youtube.com/watch");
		});
	});

	describe("INVARIANT: Selector Validity", () => {
		test("all selectors are valid CSS", () => {
			// Test each selector can be used with cheerio
			for (const [, selector] of Object.entries(SITE_SELECTORS)) {
				// Should not throw when parsing
				expect(() => {
					const $ = cheerio.load("<html></html>");
					$(selector);
				}).not.toThrow();
			}
		});

		test("selectors are not empty", () => {
			for (const [, selector] of Object.entries(SITE_SELECTORS)) {
				expect(selector.length).toBeGreaterThan(0);
				expect(selector.trim()).toBe(selector); // No leading/trailing whitespace
			}
		});

		test("patterns are not empty", () => {
			for (const pattern of Object.keys(SITE_SELECTORS)) {
				expect(pattern.length).toBeGreaterThan(0);
			}
		});
	});

	describe("INTEGRATION: Selector Functionality", () => {
		test("YouTube selector finds video title element", () => {
			const html = `
				<ytd-video-primary-info-renderer>
					<h1 class="ytd-video-primary-info-renderer">Video Title</h1>
				</ytd-video-primary-info-renderer>
			`;
			const $ = cheerio.load(html);
			const selector = SITE_SELECTORS["youtube.com/watch"];
			const element = $(selector);

			expect(element.length).toBe(1);
			expect(element.text()).toBe("Video Title");
		});

		test("Twitter/X selector finds tweet elements", () => {
			const html = `
				<div data-testid="tweet">
					<p>Tweet content 1</p>
				</div>
				<div data-testid="tweet">
					<p>Tweet content 2</p>
				</div>
			`;
			const $ = cheerio.load(html);
			const selector = SITE_SELECTORS["twitter.com"];
			const elements = $(selector);

			expect(elements.length).toBe(2);
		});

		test("GitHub selector finds repo content", () => {
			const html = `
				<div class="js-repo-root">
					<h1>Repository Name</h1>
				</div>
				<div class="repository-content">
					<p>README content</p>
				</div>
			`;
			const $ = cheerio.load(html);
			const selector = SITE_SELECTORS["github.com"];
			const elements = $(selector);

			// Multiple selectors separated by comma
			expect(elements.length).toBeGreaterThanOrEqual(1);
		});

		test("Reddit selector finds post container", () => {
			const html = `
				<div data-testid="post-container">
					<h2>Post Title</h2>
					<p>Post content</p>
				</div>
			`;
			const $ = cheerio.load(html);
			const selector = SITE_SELECTORS["reddit.com"];
			const element = $(selector);

			expect(element.length).toBe(1);
		});

		test("Medium selector finds article element", () => {
			const html = `
				<article>
					<h1>Article Title</h1>
					<p>Article content</p>
				</article>
			`;
			const $ = cheerio.load(html);
			const selector = SITE_SELECTORS["medium.com"];
			const element = $(selector);

			expect(element.length).toBe(1);
		});

		test("StackOverflow selector finds question and answers", () => {
			const html = `
				<div class="question">
					<h1>Question Title</h1>
				</div>
				<div class="answer">
					<p>Answer content</p>
				</div>
			`;
			const $ = cheerio.load(html);
			const selector = SITE_SELECTORS["stackoverflow.com"];
			const elements = $(selector);

			expect(elements.length).toBeGreaterThanOrEqual(1);
		});

		test("LinkedIn selector finds feed container", () => {
			const html = `
				<div class="feed-container-theme">
					<div class="feed-item">Post 1</div>
				</div>
			`;
			const $ = cheerio.load(html);
			const selector = SITE_SELECTORS["linkedin.com"];
			const element = $(selector);

			expect(element.length).toBe(1);
		});

		test("selector returns empty when element not present", () => {
			const html = "<html><body><p>No matching content</p></body></html>";
			const $ = cheerio.load(html);
			const selector = SITE_SELECTORS["youtube.com/watch"];
			const element = $(selector);

			expect(element.length).toBe(0);
		});
	});

	describe("EDGE CASE: Pattern Matching", () => {
		test("handles subdomains", () => {
			const url = "https://mobile.twitter.com/user/status/123";
			const selector = Object.entries(SITE_SELECTORS).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			// Should match twitter.com pattern
			expect(selector).toBe('[data-testid="tweet"]');
		});

		test("handles HTTP protocol", () => {
			const url = "http://github.com/user/repo";
			const selector = Object.entries(SITE_SELECTORS).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			expect(selector).toBe(".js-repo-root, .repository-content");
		});

		test("handles trailing slash in URL", () => {
			const url = "https://reddit.com/r/test/";
			const selector = Object.entries(SITE_SELECTORS).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			expect(selector).toBe('[data-testid="post-container"]');
		});
	});
});

describe("SITE_COOKIES CONTRACT", () => {
	describe("INVARIANT: Cookie Format", () => {
		test("provides YouTube consent cookies", () => {
			const url = "https://www.youtube.com/watch?v=abc123";
			const cookies = Object.entries(SITE_COOKIES).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			expect(cookies).toBeDefined();
			expect(cookies?.length).toBe(2);
			expect(cookies?.find((c) => c.name === "CONSENT")).toBeDefined();
			expect(cookies?.find((c) => c.name === "PREF")).toBeDefined();
		});

		test("provides Reddit age verification cookie", () => {
			const url = "https://www.reddit.com/r/test";
			const cookies = Object.entries(SITE_COOKIES).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			expect(cookies).toBeDefined();
			expect(cookies?.length).toBe(1);
			expect(cookies?.[0].name).toBe("over18");
			expect(cookies?.[0].value).toBe("1");
		});

		test("returns undefined for sites without configured cookies", () => {
			const url = "https://github.com/user/repo";
			const cookies = Object.entries(SITE_COOKIES).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			expect(cookies).toBeUndefined();
		});

		test("all cookies have name and value fields", () => {
			for (const [, cookies] of Object.entries(SITE_COOKIES)) {
				for (const cookie of cookies) {
					expect(cookie.name).toBeDefined();
					expect(cookie.value).toBeDefined();
					expect(typeof cookie.name).toBe("string");
					expect(typeof cookie.value).toBe("string");
					expect(cookie.name.length).toBeGreaterThan(0);
					expect(cookie.value.length).toBeGreaterThan(0);
				}
			}
		});

		test("cookie values are properly escaped", () => {
			for (const [, cookies] of Object.entries(SITE_COOKIES)) {
				for (const cookie of cookies) {
					// Cookie values should not contain control characters
					expect(cookie.value).not.toContain("\n");
					expect(cookie.value).not.toContain("\r");
					expect(cookie.value).not.toContain(";"); // Would break cookie header
				}
			}
		});
	});

	describe("INVARIANT: Cookie Semantics", () => {
		test("YouTube CONSENT cookie signals acceptance", () => {
			const cookies = SITE_COOKIES["youtube.com"];
			const consentCookie = cookies.find((c) => c.name === "CONSENT");

			expect(consentCookie?.value).toContain("YES");
		});

		test("Reddit over18 cookie signals age verification", () => {
			const cookies = SITE_COOKIES["reddit.com"];

			expect(cookies[0].name).toBe("over18");
			expect(cookies[0].value).toBe("1");
		});

		test("no duplicate cookie names for same site", () => {
			for (const [, cookies] of Object.entries(SITE_COOKIES)) {
				const names = cookies.map((c) => c.name);
				const uniqueNames = [...new Set(names)];
				expect(names.length).toBe(uniqueNames.length);
			}
		});
	});

	describe("EDGE CASE: Pattern Matching", () => {
		test("handles YouTube subdomains", () => {
			const url = "https://music.youtube.com/watch?v=abc123";
			const cookies = Object.entries(SITE_COOKIES).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			// Should match youtube.com pattern
			expect(cookies).toBeDefined();
		});

		test("handles Reddit subdomains", () => {
			const url = "https://old.reddit.com/r/test";
			const cookies = Object.entries(SITE_COOKIES).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			// Should match reddit.com pattern
			expect(cookies).toBeDefined();
		});

		test("handles URLs with query strings", () => {
			const url = "https://www.youtube.com/watch?v=abc123&feature=share";
			const cookies = Object.entries(SITE_COOKIES).find(([pattern]) =>
				url.includes(pattern),
			)?.[1];

			expect(cookies).toBeDefined();
		});
	});
});

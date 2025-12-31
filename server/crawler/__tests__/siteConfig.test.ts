import { describe, expect, test } from "bun:test";
import { SITE_COOKIES, SITE_SELECTORS } from "../../constants.js";

describe("SITE_SELECTORS configuration", () => {
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

	test("returns undefined for unknown URLs", () => {
		const url = "https://unknown-site.com/page";
		const selector = Object.entries(SITE_SELECTORS).find(([pattern]) =>
			url.includes(pattern),
		)?.[1];

		expect(selector).toBeUndefined();
	});

	test("includes all expected sites", () => {
		const expectedSites = [
			"youtube.com/watch",
			"twitter.com",
			"x.com",
			"linkedin.com",
			"instagram.com",
			"reddit.com",
			"facebook.com",
			"meta.com",
			"github.com",
			"medium.com",
			"stackoverflow.com",
		];

		for (const site of expectedSites) {
			expect(SITE_SELECTORS[site]).toBeDefined();
		}
	});
});

describe("SITE_COOKIES configuration", () => {
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
});

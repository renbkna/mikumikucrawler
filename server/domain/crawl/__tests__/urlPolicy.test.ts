import { describe, expect, test } from "bun:test";
import type { CrawlOptions } from "../../../../shared/contracts/index.js";
import type { ExtractedLink } from "../../../types.js";
import { getCrawlUrlIdentity, normalizeDiscoveredLink } from "../UrlPolicy.js";

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

function normalize(
	link: ExtractedLink,
	options = makeOptions(),
	documentUrl = "https://example.com/start",
) {
	return normalizeDiscoveredLink(link, options, documentUrl);
}

describe("crawl URL identity", () => {
	test("derives canonical, origin, and budget identities from one URL", () => {
		const identity = getCrawlUrlIdentity(
			"HTTPS://Example.COM:443/path/?b=2&a=1&utm_source=x#section",
		);

		expect(identity).toEqual({
			canonicalUrl: "https://example.com/path/?b=2&a=1&utm_source=x",
			hostname: "example.com",
			originKey: "https://example.com",
			domainBudgetKey: "example.com",
			skippedByExtension: false,
		});
	});

	test("collapses DNS trailing-dot aliases across every derived identity", () => {
		expect(getCrawlUrlIdentity("https://Example.COM./path")).toMatchObject({
			canonicalUrl: "https://example.com/path",
			hostname: "example.com",
			originKey: "https://example.com",
			domainBudgetKey: "example.com",
		});
	});

	test("preserves ports in origin identity while keeping hostname budget identity", () => {
		const identity = getCrawlUrlIdentity("http://blog.example.com:8080/page");

		expect(identity).toMatchObject({
			canonicalUrl: "http://blog.example.com:8080/page",
			originKey: "http://blog.example.com:8080",
			domainBudgetKey: "blog.example.com",
		});
	});
});

describe("discovered URL normalization", () => {
	test("rejects unsupported schemes and skipped resource extensions with diagnostic reasons", () => {
		const cases = [
			["mailto:test@example.com", "invalid-url"],
			["javascript:void(0)", "invalid-url"],
			["ftp://files.example.com", "invalid-url"],
			["https://example.com/app.css", "resource-extension"],
			["https://example.com/archive.zip", "resource-extension"],
		] as const;

		for (const [url, reason] of cases) {
			expect(normalize({ url })).toMatchObject({ reason });
		}
	});

	test("retains supported JSON and PDF documents", () => {
		const urls = [
			"https://example.com/releases/data.JSON?download=1",
			"https://example.com/releases/manual.pdf?download=1",
		];

		expect(
			urls
				.map((url) => normalize({ url }))
				.map((result) => ("error" in result ? result.error : result.link.url)),
		).toEqual(urls);
	});

	test("treats scheme and port changes as external origin changes", () => {
		for (const url of ["https://example.com/page", "http://example.com:8080/page"]) {
			expect(normalize({ url }, makeOptions(), "http://example.com/start")).toMatchObject({
				reason: "external-link",
			});
		}
	});

	test("allows external origins only in full crawl mode", () => {
		const link = { url: "https://external.example/page" };

		expect(normalize(link)).toMatchObject({ reason: "external-link" });
		expect(normalize(link, makeOptions({ crawlMethod: "full" }))).toMatchObject({
			link: { url: link.url, nofollow: false },
		});
	});

	test("rejects localhost and private IP targets in full crawl mode", () => {
		const urls = [
			"http://localhost:3000/admin",
			"http://127.0.0.1:8080/internal",
			"http://10.0.0.1/api",
			"http://[::1]:9090",
		];

		for (const url of urls) {
			expect(normalize({ url }, makeOptions({ crawlMethod: "full" }))).toMatchObject({
				reason: "ssrf-blocked",
			});
		}
	});

	test("normalizes a bare document hostname as HTTP instead of fabricating an HTTPS origin", () => {
		expect(normalize({ url: "https://example.com/page" }, makeOptions(), "example.com")).toEqual({
			error: "External links require full crawl mode",
			reason: "external-link",
		});
	});

	test("normalizes nofollow to the boundary boolean contract", () => {
		expect(normalize({ url: "https://example.com/a", nofollow: undefined })).toMatchObject({
			link: { nofollow: false },
		});
		expect(normalize({ url: "https://example.com/b", nofollow: true })).toMatchObject({
			link: { nofollow: true },
		});
	});
});

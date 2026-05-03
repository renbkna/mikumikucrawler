import { describe, expect, mock, test } from "bun:test";
import type { CrawlOptions } from "../../../../shared/contracts/index.js";
import { CrawlAdmissionPolicy } from "../CrawlAdmissionPolicy.js";
import type { QueueItem } from "../CrawlQueue.js";

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
		respectRobots: true,
		contentOnly: false,
		saveMedia: false,
		...overrides,
	};
}

const parent: QueueItem = {
	url: "https://example.com/start",
	domain: "example.com",
	depth: 0,
	retries: 0,
};

describe("CrawlAdmissionPolicy", () => {
	test("normalizes crawl-visible links independently from depth-limited enqueue", () => {
		const policy = new CrawlAdmissionPolicy(
			makeOptions({ crawlDepth: 0 }),
			{ setDomainDelay: mock(() => undefined) } as never,
			{ enqueueNormalized: mock(() => true) } as never,
			{
				evaluateIdentity: mock(async () => ({ allowed: true, delayKey: "" })),
			} as never,
		);

		const normalized = policy.normalizeDiscoveredLinks(parent, [
			{ url: "HTTPS://Example.com:443/page?b=2&a=1#section" },
			{ url: "https://example.com/app.css" },
		]);

		expect(normalized.map((link) => link.link.url)).toEqual([
			"https://example.com/page?a=1&b=2",
		]);
	});

	test("applies URL filtering, nofollow, robots, delay, and queue admission in one boundary", async () => {
		const setDomainDelay = mock(() => undefined);
		const enqueueNormalized = mock(() => true);
		const evaluateIdentity = mock(
			async (identity: { canonicalUrl: string }) => ({
				allowed: !identity.canonicalUrl.endsWith("/blocked"),
				delayKey: "https://example.com",
				crawlDelayMs: identity.canonicalUrl.endsWith("/allowed")
					? 500
					: undefined,
			}),
		);
		const policy = new CrawlAdmissionPolicy(
			makeOptions(),
			{ setDomainDelay } as never,
			{ enqueueNormalized } as never,
			{ evaluateIdentity } as never,
		);

		const results = await policy.admitDiscoveredLinks(parent, [
			{ url: "https://example.com/allowed" },
			{ url: "https://other.example/external" },
			{ url: "https://example.com/app.css" },
			{ url: "https://example.com/nofollow", nofollow: true },
			{ url: "https://example.com/blocked" },
		]);

		expect(results).toEqual([
			expect.objectContaining({
				type: "admitted",
				item: expect.objectContaining({
					url: "https://example.com/allowed",
					domain: "example.com",
					depth: 1,
					retries: 0,
					parentUrl: "https://example.com/start",
				}),
			}),
			{
				type: "rejected",
				reason: "external-link",
				url: "https://other.example/external",
			},
			{
				type: "rejected",
				reason: "resource-extension",
				url: "https://example.com/app.css",
			},
			{
				type: "rejected",
				reason: "nofollow",
				url: "https://example.com/nofollow",
			},
			{
				type: "rejected",
				reason: "robots-disallowed",
				url: "https://example.com/blocked",
			},
		]);
		expect(setDomainDelay).toHaveBeenCalledWith("https://example.com", 500);
		expect(enqueueNormalized).toHaveBeenCalledTimes(1);
		expect(evaluateIdentity).toHaveBeenCalledTimes(2);
	});

	test("applies robots crawl-delay by origin while keeping budget domain on the queued item", async () => {
		const setDomainDelay = mock(() => undefined);
		const enqueueNormalized = mock(() => true);
		const policy = new CrawlAdmissionPolicy(
			makeOptions({ crawlMethod: "full" }),
			{ setDomainDelay } as never,
			{ enqueueNormalized } as never,
			{
				evaluateIdentity: mock(async (identity: { originKey: string }) => ({
					allowed: true,
					delayKey: identity.originKey,
					crawlDelayMs: 1200,
				})),
			} as never,
		);

		await policy.admitDiscoveredLinks(parent, [
			{ url: "http://example.com:8080/slow" },
		]);

		expect(setDomainDelay).toHaveBeenCalledWith(
			"http://example.com:8080",
			1200,
		);
		expect(enqueueNormalized).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "http://example.com:8080/slow",
				domain: "example.com",
			}),
		);
	});
});

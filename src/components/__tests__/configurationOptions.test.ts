import { describe, expect, test } from "bun:test";
import { parseCrawlIntegerOption } from "../ConfigurationView";

describe("crawl option editor", () => {
	test("constructs bounded integers for every numeric crawl option", () => {
		for (const [option, rawValue, expected] of [
			["crawlDepth", "1.5", 2],
			["crawlDelay", "250.5", 251],
			["maxPages", "not-a-number", 1],
			["maxPagesPerDomain", "12.5", 13],
			["maxConcurrentRequests", "99", 10],
			["retryLimit", "-1", 0],
		] as const) {
			expect(parseCrawlIntegerOption(option, rawValue), option).toBe(expected);
		}
	});
});

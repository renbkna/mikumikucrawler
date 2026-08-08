import { describe, expect, test } from "bun:test";
import { getLogCategory, parseLog } from "../logParser";

describe("log parser", () => {
	test("classifies the runtime's plain-text log messages", () => {
		expect(parseLog("Fetching https://example.com").level).toBe("info");
		expect(parseLog("Request failed").level).toBe("error");
		expect(parseLog("Crawl completed").level).toBe("success");
		expect(parseLog("queued page").level).toBe("unknown");
		expect(getLogCategory("Fetching https://example.com")).toBe("🌐 Network");
	});
});

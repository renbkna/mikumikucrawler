import { describe, expect, test } from "bun:test";
import { assessMemoryStatus } from "../memoryMonitor.js";

describe("browser memory admission", () => {
	test("the configured RSS threshold is the only memory admission policy", () => {
		expect(assessMemoryStatus({ rss: 350, heapUsed: 200 }, 350).isLowMemory).toBe(false);
		expect(assessMemoryStatus({ rss: 351, heapUsed: 20 }, 350).isLowMemory).toBe(true);
	});
});

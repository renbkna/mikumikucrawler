import { describe, expect, test } from "bun:test";
import { getLogCategory, parseLog } from "../logParser";

describe("log parser", () => {
	test("falls back to the raw log when a structured message is not text", () => {
		const raw = JSON.stringify({ level: "info", message: { text: "nested" } });

		const parsed = parseLog(raw);

		expect(parsed.message).toBe(raw);
		expect(parsed.level).toBe("info");
		expect(getLogCategory(parsed.message)).toBe("📝 System");
	});

	test("rejects unknown structured levels instead of trusting arbitrary strings", () => {
		const parsed = parseLog(JSON.stringify({ level: "fatal", message: "failed" }));

		expect(parsed.level).toBe("unknown");
		expect(parsed.message).toBe("failed");
	});
});

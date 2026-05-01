import { describe, expect, test } from "bun:test";
import { shouldResetTheatreStatus } from "../theatreStatus";

describe("theatre status contract", () => {
	test("any non-idle overlay state clears when crawl activity ends", () => {
		expect(shouldResetTheatreStatus("blackout", false)).toBe(true);
		expect(shouldResetTheatreStatus("counting", false)).toBe(true);
		expect(shouldResetTheatreStatus("beam", false)).toBe(true);
		expect(shouldResetTheatreStatus("live", false)).toBe(true);
	});

	test("active crawls and idle state do not trigger a reset", () => {
		expect(shouldResetTheatreStatus("blackout", true)).toBe(false);
		expect(shouldResetTheatreStatus("idle", false)).toBe(false);
	});
});

import { describe, expect, test } from "bun:test";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
	parseSseLastEventId,
	SSE_LAST_EVENT_ID_MAX,
	SSE_LAST_EVENT_ID_MAX_LENGTH,
	SseHeadersSchema,
} from "../http.js";

describe("SSE replay cursor ingress", () => {
	test("accepts only bounded safe non-negative integer cursors", () => {
		expect(parseSseLastEventId(undefined)).toBe(0);
		expect(parseSseLastEventId("0")).toBe(0);
		expect(parseSseLastEventId(String(SSE_LAST_EVENT_ID_MAX))).toBe(SSE_LAST_EVENT_ID_MAX);
		expect(parseSseLastEventId(String(SSE_LAST_EVENT_ID_MAX + 1))).toBeNull();
		expect(parseSseLastEventId("01")).toBeNull();
		expect(parseSseLastEventId("1.5")).toBeNull();
	});

	test("bounds cursor text before numeric parsing", () => {
		expect(SSE_LAST_EVENT_ID_MAX_LENGTH).toBe(16);
		expect(
			Value.Check(SseHeadersSchema as unknown as TSchema, {
				"last-event-id": "9".repeat(SSE_LAST_EVENT_ID_MAX_LENGTH + 1),
			}),
		).toBe(false);
	});
});

import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { CrawlEventEnvelopeSchema } from "../events.js";

const counters = {
	pagesScanned: 0,
	successCount: 0,
	failureCount: 0,
	skippedCount: 0,
	linksFound: 0,
	mediaFiles: 0,
	totalDataKb: 0,
};

const baseEvent = {
	crawlId: "crawl-1",
	sequence: 1,
	timestamp: "2026-04-30T00:00:00.000Z",
};

describe("crawl event schema", () => {
	const app = new Elysia().post("/event", ({ body }) => body, {
		body: CrawlEventEnvelopeSchema,
	});

	test("accepts payload matching its event type", async () => {
		const response = await app.handle(
			new Request("http://localhost/event", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...baseEvent,
					type: "crawl.completed",
					payload: { counters },
				}),
			}),
		);

		expect(response.status).toBe(200);
	});

	test("rejects payload from a different event type", async () => {
		const response = await app.handle(
			new Request("http://localhost/event", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...baseEvent,
					type: "crawl.completed",
					payload: { message: "not completed payload" },
				}),
			}),
		);

		expect(response.status).toBe(422);
	});
});

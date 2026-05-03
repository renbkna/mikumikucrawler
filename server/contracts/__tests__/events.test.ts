import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { CrawlEventEnvelopeSchema } from "../../../shared/contracts/schemas.js";

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

	test("accepts paused lifecycle events", async () => {
		const response = await app.handle(
			new Request("http://localhost/event", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...baseEvent,
					type: "crawl.paused",
					payload: { counters, stopReason: "Pause requested" },
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

	test("rejects fractional event sequences", async () => {
		const response = await app.handle(
			new Request("http://localhost/event", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...baseEvent,
					sequence: 1.5,
					type: "crawl.completed",
					payload: { counters },
				}),
			}),
		);

		expect(response.status).toBe(422);
	});

	test("rejects negative progress metrics", async () => {
		const response = await app.handle(
			new Request("http://localhost/event", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...baseEvent,
					type: "crawl.progress",
					payload: {
						counters: {
							...counters,
							pagesScanned: -1,
						},
						queue: {
							activeRequests: -1,
							queueLength: 0,
							elapsedTime: 0,
							pagesPerSecond: -1,
						},
						elapsedSeconds: -1,
						pagesPerSecond: -1,
						stopReason: null,
					},
				}),
			}),
		);

		expect(response.status).toBe(422);
	});

	test("rejects fractional page payload ids", async () => {
		const response = await app.handle(
			new Request("http://localhost/event", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...baseEvent,
					type: "crawl.page",
					payload: {
						id: 1.5,
						url: "https://example.com/page",
					},
				}),
			}),
		);

		expect(response.status).toBe(422);
	});

	test("rejects malformed nested processed page data", async () => {
		const response = await app.handle(
			new Request("http://localhost/event", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...baseEvent,
					type: "crawl.page",
					payload: {
						id: 1,
						url: "https://example.com/page",
						processedData: {
							extractedData: {},
							metadata: {},
							analysis: {},
							media: [],
							errors: { length: 1 },
							qualityScore: 0,
							language: "unknown",
						},
					},
				}),
			}),
		);

		expect(response.status).toBe(422);
	});
});

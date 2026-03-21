import { Elysia } from "elysia";
import { CrawlIdParamsSchema } from "../contracts/crawl.js";
import { ApiErrorSchema } from "../contracts/errors.js";
import { SseHeadersSchema } from "../contracts/http.js";
import { createEventStreamResponse } from "../plugins/sse.js";
import type { CrawlManager } from "../runtime/CrawlManager.js";
import type { EventStream } from "../runtime/EventStream.js";

export function sseApi() {
	return new Elysia({ name: "sse-api", prefix: "/api/crawls" }).get(
		"/:id/events",
		(context) => {
			const { crawlManager, eventStream, headers, params, request, set } =
				context as typeof context & {
					crawlManager: CrawlManager;
					eventStream: EventStream;
				};
			const crawl = crawlManager.get(params.id);
			if (!crawl) {
				set.status = 404;
				return { error: "Crawl not found" };
			}

			const requestedSequence = Number.parseInt(
				headers["last-event-id"] ?? "0",
				10,
			);
			return createEventStreamResponse({
				crawlId: params.id,
				eventStream,
				afterSequence: Number.isNaN(requestedSequence) ? 0 : requestedSequence,
				requestSignal: request.signal,
			});
		},
		{
			headers: SseHeadersSchema,
			params: CrawlIdParamsSchema,
			response: {
				404: ApiErrorSchema,
			},
			detail: {
				tags: ["Crawls"],
				summary: "Subscribe to crawl events",
			},
		},
	);
}

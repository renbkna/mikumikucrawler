import { Elysia, t } from "elysia";
import { API_PATHS, CRAWL_ROUTE_SEGMENTS } from "../../shared/contracts/index.js";
import { CrawlIdParamsSchema } from "../../shared/contracts/schemas.js";
import { ApiErrorSchema } from "../contracts/errors.js";
import { parseSseLastEventId, SseHeadersSchema } from "../contracts/http.js";
import { createEventStreamResponse } from "../plugins/sse.js";
import type { RouteServicesPlugin } from "./context.js";

export function sseApi(services: RouteServicesPlugin) {
	return new Elysia({ name: "sse-api", prefix: API_PATHS.crawls }).use(services).get(
		CRAWL_ROUTE_SEGMENTS.events,
		({ crawlManager, eventStream, headers, params, request, status }) => {
			const requestedSequence = parseSseLastEventId(headers["last-event-id"]);
			if (requestedSequence === null) {
				return status(422, {
					error: "Last-Event-ID must be a safe non-negative integer",
					code: "INVALID_LAST_EVENT_ID",
				});
			}

			const crawl = crawlManager.get(params.id);
			if (!crawl) {
				return status(404, { error: "Crawl not found" });
			}
			if (!eventStream.hasSubscriberCapacity(params.id)) {
				return status(429, {
					error: "SSE subscriber capacity reached",
					code: "SSE_CAPACITY_REACHED",
				});
			}

			return createEventStreamResponse({
				crawlId: params.id,
				eventStream,
				afterSequence: requestedSequence,
				requestSignal: request.signal,
			});
		},
		{
			headers: SseHeadersSchema,
			params: CrawlIdParamsSchema,
			response: {
				200: t.String(),
				404: ApiErrorSchema,
				422: ApiErrorSchema,
				429: ApiErrorSchema,
			},
			detail: {
				tags: ["Crawls"],
				summary: "Subscribe to crawl events",
			},
		},
	);
}

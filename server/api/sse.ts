import { Elysia, t } from "elysia";
import { API_PATHS, CRAWL_ROUTE_SEGMENTS } from "../../shared/contracts/index.js";
import { CrawlIdParamsSchema } from "../../shared/contracts/schemas.js";
import { ApiErrorSchema } from "../contracts/errors.js";
import { parseSseLastEventId, SseHeadersSchema } from "../contracts/http.js";
import { createEventStreamResponse } from "../plugins/sse.js";
import { routeServices } from "./context.js";

export function sseApi() {
	return new Elysia({ name: "sse-api", prefix: API_PATHS.crawls }).get(
		CRAWL_ROUTE_SEGMENTS.events,
		(context) => {
			const { crawlManager, eventStream, headers, params, request, set } = routeServices(context);
			const requestedSequence = parseSseLastEventId(headers["last-event-id"]);
			if (requestedSequence === null) {
				set.status = 422;
				return {
					error: "Last-Event-ID must be a safe non-negative integer",
					code: "INVALID_LAST_EVENT_ID",
				};
			}

			const crawl = crawlManager.get(params.id);
			if (!crawl) {
				set.status = 404;
				return { error: "Crawl not found" };
			}
			if (!eventStream.hasSubscriberCapacity(params.id)) {
				set.status = 429;
				return {
					error: "SSE subscriber capacity reached",
					code: "SSE_CAPACITY_REACHED",
				};
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

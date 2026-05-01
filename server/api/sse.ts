import { Elysia, t } from "elysia";
import { API_PATHS, CRAWL_ROUTE_SEGMENTS } from "../../shared/contracts/api.js";
import { CrawlIdParamsSchema } from "../contracts/crawl.js";
import { ApiErrorSchema } from "../contracts/errors.js";
import { SseHeadersSchema } from "../contracts/http.js";
import { createEventStreamResponse } from "../plugins/sse.js";
import { routeServices } from "./context.js";

export function sseApi() {
	return new Elysia({ name: "sse-api", prefix: API_PATHS.crawls }).get(
		CRAWL_ROUTE_SEGMENTS.events,
		(context) => {
			const { crawlManager, eventStream, headers, params, request, set } =
				routeServices(context);
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
				200: t.String(),
				404: ApiErrorSchema,
				422: ApiErrorSchema,
			},
			detail: {
				tags: ["Crawls"],
				summary: "Subscribe to crawl events",
			},
		},
	);
}

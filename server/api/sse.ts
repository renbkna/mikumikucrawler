import { Elysia, t } from "elysia";
import { API_PATHS, CRAWL_ROUTE_SEGMENTS } from "../../shared/contracts/index.js";
import { CrawlIdParamsSchema } from "../../shared/contracts/schemas.js";
import { ApiErrorSchema } from "../contracts/errors.js";
import { SseHeadersSchema } from "../contracts/http.js";
import { createCrawlEventStream } from "../plugins/sse.js";
import type { RouteServicesPlugin } from "./context.js";

export function sseApi(services: RouteServicesPlugin) {
	return new Elysia({ name: "sse-api", prefix: API_PATHS.crawls }).use(services).get(
		CRAWL_ROUTE_SEGMENTS.events,
		({ crawlManager, eventStream, headers, params, request, server, set, status }) => {
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

			server?.timeout(request, 0);
			set.headers["cache-control"] = "no-cache, no-transform";
			set.headers["x-accel-buffering"] = "no";

			return createCrawlEventStream({
				crawlId: params.id,
				eventStream,
				afterSequence: headers["last-event-id"] ?? 0,
			});
		},
		{
			headers: SseHeadersSchema,
			params: CrawlIdParamsSchema,
			response: {
				200: t.Unknown(),
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

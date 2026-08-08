import { Elysia } from "elysia";
import { API_PATHS, CRAWL_ROUTE_SEGMENTS } from "../../shared/contracts/index.js";
import { CrawlIdParamsSchema } from "../../shared/contracts/schemas.js";
import { ApiErrorSchema } from "../contracts/errors.js";
import { SseHeadersSchema } from "../contracts/http.js";
import { createCrawlEventStream } from "../plugins/sse.js";
import type { RouteServicesPlugin } from "./context.js";

export function sseApi(services: RouteServicesPlugin) {
	const app = new Elysia({ name: "sse-api", prefix: API_PATHS.crawls }).use(services);

	return app.get(
		CRAWL_ROUTE_SEGMENTS.events,
		{
			headers: SseHeadersSchema,
			params: CrawlIdParamsSchema,
			response: {
				404: ApiErrorSchema,
				422: ApiErrorSchema,
				429: ApiErrorSchema,
			},
			detail: {
				tags: ["Crawls"],
				summary: "Subscribe to crawl events",
			},
		},
		async ({
			crawlManager,
			eventStream,
			headers,
			params,
			resolveClientKey,
			request,
			server,
			set,
			status,
		}) => {
			const crawl = crawlManager.get(params.id);
			if (!crawl) {
				return status(404, { error: "Crawl not found" });
			}
			const clientKey = await resolveClientKey(request, server);
			if (!eventStream.hasSubscriberCapacity(params.id, clientKey)) {
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
				clientKey,
			});
		},
	);
}

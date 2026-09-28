import { Elysia, t } from "elysia";
import { API_PATHS, CRAWL_ROUTE_SEGMENTS } from "../../shared/contracts/index.js";
import { CrawlIdParamsSchema } from "../../shared/contracts/schemas.js";
import { ApiErrorSchema } from "../contracts/errors.js";
import { createCrawlEventStream } from "../plugins/sse.js";
import type { RouteServicesPlugin } from "./context.js";

export function sseApi(services: RouteServicesPlugin) {
	const app = new Elysia({ name: "sse-api", prefix: API_PATHS.crawls }).use(services);

	return app.get(
		CRAWL_ROUTE_SEGMENTS.events,
		{
			params: CrawlIdParamsSchema,
			response: {
				204: t.Void({ description: "Crawl has no live runtime; read its snapshot instead" }),
				404: ApiErrorSchema,
				422: ApiErrorSchema,
				429: ApiErrorSchema,
			},
			detail: {
				tags: ["Crawls"],
				summary: "Subscribe to crawl events",
			},
		},
		({ crawlManager, eventStream, keepOpen, params, resolveClientKey, request, set, status }) => {
			const clientKey = resolveClientKey(request);
			const crawl = crawlManager.get(params.id);
			if (!crawl) {
				return status(404, { error: "Crawl not found" });
			}
			// The stream carries only events published after subscription; settled crawls have none.
			if (!crawlManager.hasLiveRuntime(params.id)) {
				return new Response(null, { status: 204 });
			}
			if (!eventStream.hasSubscriberCapacity(params.id, clientKey)) {
				return status(429, {
					error: "SSE subscriber capacity reached",
					code: "SSE_CAPACITY_REACHED",
				});
			}

			keepOpen(request);
			set.headers["cache-control"] = "no-cache, no-transform";
			set.headers["x-accel-buffering"] = "no";

			return createCrawlEventStream({
				crawlId: params.id,
				eventStream,
				clientKey,
			});
		},
	);
}

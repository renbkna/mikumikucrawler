import { Elysia } from "elysia";
import type { ClientKeyResolver, RequestTransport } from "../config/rateLimit.js";
import type { CrawlManager } from "../runtime/CrawlManager.js";
import type { EventStream } from "../runtime/EventStream.js";
import type { StorageRepos } from "../storage/db.js";

export interface RouteServices {
	crawlManager: CrawlManager;
	eventStream: EventStream;
	repos: StorageRepos;
	resolveClientKey: ClientKeyResolver;
	keepOpen: RequestTransport["keepOpen"];
}

export function routeServicesPlugin(services: RouteServices) {
	return new Elysia({ name: "route-services" })
		.decorate("crawlManager", services.crawlManager)
		.decorate("eventStream", services.eventStream)
		.decorate("repos", services.repos)
		.decorate("resolveClientKey", services.resolveClientKey)
		.decorate("keepOpen", services.keepOpen);
}

export type RouteServicesPlugin = ReturnType<typeof routeServicesPlugin>;

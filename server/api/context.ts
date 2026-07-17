import { Elysia } from "elysia";
import type { CrawlManager } from "../runtime/CrawlManager.js";
import type { CrawlRuntime } from "../runtime/CrawlRuntime.js";
import type { EventStream } from "../runtime/EventStream.js";
import type { StorageRepos } from "../storage/db.js";

export interface RouteServices {
	crawlManager: CrawlManager;
	eventStream: EventStream;
	repos: StorageRepos;
	runtimeRegistry: Map<string, CrawlRuntime>;
}

export function routeServicesPlugin(services: RouteServices) {
	return new Elysia({ name: "route-services" })
		.decorate("crawlManager", services.crawlManager)
		.decorate("eventStream", services.eventStream)
		.decorate("repos", services.repos)
		.decorate("runtimeRegistry", services.runtimeRegistry);
}

export type RouteServicesPlugin = ReturnType<typeof routeServicesPlugin>;

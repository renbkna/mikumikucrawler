import { Elysia } from "elysia";
import type { Generator } from "elysia-rate-limit";
import type { CrawlManager } from "../runtime/CrawlManager.js";
import type { EventStream } from "../runtime/EventStream.js";
import type { StorageRepos } from "../storage/db.js";

export interface RouteServices {
	crawlManager: CrawlManager;
	eventStream: EventStream;
	repos: StorageRepos;
	resolveClientKey: (request: Request, server: Parameters<Generator>[1]) => ReturnType<Generator>;
}

export function routeServicesPlugin(services: RouteServices) {
	return new Elysia({ name: "route-services" })
		.decorate("crawlManager", services.crawlManager)
		.decorate("eventStream", services.eventStream)
		.decorate("repos", services.repos)
		.decorate("resolveClientKey", services.resolveClientKey);
}

export type RouteServicesPlugin = ReturnType<typeof routeServicesPlugin>;

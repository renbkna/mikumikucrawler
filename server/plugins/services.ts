import { Elysia } from "elysia";
import type { CrawlManager } from "../runtime/CrawlManager.js";
import type { EventStream } from "../runtime/EventStream.js";
import type { RuntimeRegistry } from "../runtime/RuntimeRegistry.js";

interface ServicePluginDependencies {
	crawlManager: CrawlManager;
	eventStream: EventStream;
	runtimeRegistry: RuntimeRegistry;
}

export function servicesPlugin({
	crawlManager,
	eventStream,
	runtimeRegistry,
}: ServicePluginDependencies) {
	return new Elysia({ name: "services-plugin" })
		.decorate("crawlManager", crawlManager)
		.decorate("eventStream", eventStream)
		.decorate("runtimeRegistry", runtimeRegistry);
}

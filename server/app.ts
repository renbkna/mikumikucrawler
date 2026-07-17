import { lookup } from "node:dns/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cors } from "@elysiajs/cors";
import { serverTiming } from "@elysiajs/server-timing";
import { Elysia } from "elysia";
import { type Generator, rateLimit } from "elysia-rate-limit";
import { API_PATHS, isCrawlEventsPath } from "../shared/contracts/index.js";
import { routeServicesPlugin } from "./api/context.js";
import { crawlsApi } from "./api/crawls.js";
import { healthApi } from "./api/health.js";
import { pagesApi } from "./api/pages.js";
import { searchApi } from "./api/search.js";
import { sseApi } from "./api/sse.js";
import { isCorsOriginAllowed } from "./config/cors.js";
import { config } from "./config/env.js";
import type { AppLogger } from "./config/logging.js";
import { createRateLimitKeyGenerator } from "./config/rateLimit.js";
import type { ApiErrorSchema } from "./contracts/errors.js";
import { handleAppError } from "./errorHandling.js";
import { openapiPlugin } from "./plugins/openapi.js";
import {
	DefaultResolver,
	type HttpClient,
	PinnedHttpClient,
	type Resolver,
	securityPlugin,
} from "./plugins/security.js";
import { spaStaticPlugin } from "./plugins/spaStatic.js";
import { CrawlManager } from "./runtime/CrawlManager.js";
import type { CrawlRuntime } from "./runtime/CrawlRuntime.js";
import { EventStream } from "./runtime/EventStream.js";
import { createStorage, type Storage } from "./storage/db.js";

const moduleFilename = fileURLToPath(import.meta.url);
const moduleDirectory = path.dirname(moduleFilename);
const distPath = path.join(moduleDirectory, "..", "dist");

function isRateLimitExempt(request: Request): boolean {
	const pathname = new URL(request.url).pathname;
	return pathname === API_PATHS.health || isCrawlEventsPath(pathname);
}

export interface AppDependencies {
	logger: AppLogger;
	storage: Storage;
	resolver: Resolver;
	httpClient: HttpClient;
	eventStream: EventStream;
	runtimeRegistry: Map<string, CrawlRuntime>;
	crawlManager: CrawlManager;
	rateLimitGenerator: Generator;
}

export function createDefaultAppDependencies(logger: AppLogger): AppDependencies {
	const storage = createStorage();
	const resolver = new DefaultResolver(lookup, config.allowLocalhostTargets);
	const httpClient = new PinnedHttpClient(resolver);
	const eventStream = new EventStream();
	const runtimeRegistry = new Map<string, CrawlRuntime>();
	const crawlManager = new CrawlManager({
		logger,
		repos: storage.repos,
		eventStream,
		registry: runtimeRegistry,
		resolver,
		httpClient,
		allowLocalhostSeed: config.allowLocalhostTargets,
	});

	return {
		logger,
		storage,
		resolver,
		httpClient,
		eventStream,
		runtimeRegistry,
		crawlManager,
		rateLimitGenerator: createRateLimitKeyGenerator(config.isRender),
	};
}

export function createApp(deps: AppDependencies) {
	const routeServices = routeServicesPlugin({
		crawlManager: deps.crawlManager,
		eventStream: deps.eventStream,
		repos: deps.storage.repos,
		runtimeRegistry: deps.runtimeRegistry,
	});

	const app = new Elysia()
		.use(securityPlugin(deps.resolver, deps.httpClient))
		.decorate("logger", deps.logger)
		.use(
			cors({
				origin: (request) => isCorsOriginAllowed(request.headers.get("origin"), config),
				credentials: true,
			}),
		)
		.use(
			rateLimit({
				max: 100,
				duration: 60_000,
				generator: deps.rateLimitGenerator,
				skip: isRateLimitExempt,
			}),
		)
		.use(openapiPlugin());

	if (config.isDevelopment) app.use(serverTiming());

	return app
		.use(crawlsApi(routeServices))
		.use(sseApi(routeServices))
		.use(pagesApi(routeServices))
		.use(searchApi(routeServices))
		.use(healthApi(routeServices))
		.use(spaStaticPlugin({ distPath }))
		.onError(({ code, error, logger: requestLogger, status }) => {
			const response = handleAppError({
				code,
				error,
				logger: requestLogger,
			});

			return status(response.status, response.body satisfies typeof ApiErrorSchema.static);
		});
}

export type App = ReturnType<typeof createApp>;

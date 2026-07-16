import { lookup } from "node:dns/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cors } from "@elysiajs/cors";
import { opentelemetry } from "@elysiajs/opentelemetry";
import { serverTiming } from "@elysiajs/server-timing";
import { Elysia } from "elysia";
import { rateLimit } from "elysia-rate-limit";
import { API_PATHS, isCrawlEventsPath } from "../shared/contracts/index.js";
import { crawlsApi } from "./api/crawls.js";
import { healthApi } from "./api/health.js";
import { pagesApi } from "./api/pages.js";
import { searchApi } from "./api/search.js";
import { sseApi } from "./api/sse.js";
import { isCorsOriginAllowed } from "./config/cors.js";
import { config } from "./config/env.js";
import type { AppLogger } from "./config/logging.js";
import type { ApiErrorSchema } from "./contracts/errors.js";
import { handleAppError } from "./errorHandling.js";
import { compression } from "./middleware/compression.js";
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
	};
}

export function createApp(deps: AppDependencies) {
	return new Elysia()
		.use(securityPlugin(deps.resolver, deps.httpClient))
		.decorate("logger", deps.logger)
		.decorate("repos", deps.storage.repos)
		.decorate("crawlManager", deps.crawlManager)
		.decorate("eventStream", deps.eventStream)
		.decorate("runtimeRegistry", deps.runtimeRegistry)
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
				skip: isRateLimitExempt,
			}),
		)
		.use(compression())
		.use(openapiPlugin())
		.use(serverTiming())
		.use(opentelemetry())
		.use(crawlsApi())
		.use(sseApi())
		.use(pagesApi())
		.use(searchApi())
		.use(healthApi())
		.use(spaStaticPlugin({ distPath }))
		.onError(
			({ code, error, logger: requestLogger, set }) =>
				handleAppError({
					code,
					error,
					set,
					logger: requestLogger,
				}) satisfies typeof ApiErrorSchema.static,
		);
}

export type App = ReturnType<typeof createApp>;

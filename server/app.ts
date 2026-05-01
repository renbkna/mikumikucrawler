import path from "node:path";
import { fileURLToPath } from "node:url";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { rateLimit } from "elysia-rate-limit";
import { API_PATHS, isCrawlEventsPath } from "../shared/contracts/api.js";
import { crawlsApi } from "./api/crawls.js";
import { healthApi } from "./api/health.js";
import { pagesApi } from "./api/pages.js";
import { searchApi } from "./api/search.js";
import { sseApi } from "./api/sse.js";
import { config } from "./config/env.js";
import type { AppLogger } from "./config/logging.js";
import { createStartupBanner } from "./config/prettyPrinter.js";
import type { ApiErrorSchema } from "./contracts/errors.js";
import { compression } from "./middleware/compression.js";
import { dbPlugin } from "./plugins/db.js";
import { loggerPlugin } from "./plugins/logger.js";
import { openapiPlugin } from "./plugins/openapi.js";
import {
	DefaultResolver,
	type HttpClient,
	PinnedHttpClient,
	type Resolver,
	securityPlugin,
} from "./plugins/security.js";
import { servicesPlugin } from "./plugins/services.js";
import { spaStaticPlugin } from "./plugins/spaStatic.js";
import { telemetryPlugin } from "./plugins/telemetry.js";
import { CrawlManager } from "./runtime/CrawlManager.js";
import { EventStream } from "./runtime/EventStream.js";
import { RuntimeRegistry } from "./runtime/RuntimeRegistry.js";
import { handleAppError } from "./errorHandling.js";
import { createStorage, type Storage } from "./storage/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.join(__dirname, "..", "dist");

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
	runtimeRegistry: RuntimeRegistry;
	crawlManager: CrawlManager;
}

export function createDefaultAppDependencies(
	logger: AppLogger,
): AppDependencies {
	const storage = createStorage();
	const resolver = new DefaultResolver();
	const httpClient = new PinnedHttpClient(resolver);
	const eventStream = new EventStream();
	const runtimeRegistry = new RuntimeRegistry();
	const crawlManager = new CrawlManager({
		logger,
		repos: storage.repos,
		eventStream,
		registry: runtimeRegistry,
		resolver,
		httpClient,
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
		.use(loggerPlugin(deps.logger))
		.use(dbPlugin(deps.storage.repos))
		.use(securityPlugin(deps.resolver, deps.httpClient))
		.use(
			servicesPlugin({
				crawlManager: deps.crawlManager,
				eventStream: deps.eventStream,
				runtimeRegistry: deps.runtimeRegistry,
			}),
		)
		.use(
			cors({
				origin: (request) => {
					const origin = request.headers.get("origin");
					if (!config.isProduction && origin === "http://localhost:5173") {
						return true;
					}
					return origin === config.frontendUrl;
				},
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
		.use(telemetryPlugin())
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
export { createStartupBanner };

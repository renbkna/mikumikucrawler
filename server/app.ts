import path from "node:path";
import { fileURLToPath } from "node:url";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { rateLimit } from "elysia-rate-limit";
import { crawlsApi } from "./api/crawls.js";
import { healthApi } from "./api/health.js";
import { pagesApi } from "./api/pages.js";
import { searchApi } from "./api/search.js";
import { sseApi } from "./api/sse.js";
import { config } from "./config/env.js";
import { setupLogging } from "./config/logging.js";
import { createStartupBanner } from "./config/prettyPrinter.js";
import type { ApiErrorSchema } from "./contracts/errors.js";
import { compression } from "./middleware/compression.js";
import { dbPlugin } from "./plugins/db.js";
import { loggerPlugin } from "./plugins/logger.js";
import { openapiPlugin } from "./plugins/openapi.js";
import {
	DefaultResolver,
	PinnedHttpClient,
	securityPlugin,
} from "./plugins/security.js";
import { servicesPlugin } from "./plugins/services.js";
import { spaStaticPlugin } from "./plugins/spaStatic.js";
import { telemetryPlugin } from "./plugins/telemetry.js";
import { CrawlManager } from "./runtime/CrawlManager.js";
import { EventStream } from "./runtime/EventStream.js";
import { RuntimeRegistry } from "./runtime/RuntimeRegistry.js";
import { handleAppError } from "./errorHandling.js";
import { createStorage } from "./storage/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.join(__dirname, "..", "dist");

export const logger = await setupLogging();
export const storage = createStorage();
export const resolver = new DefaultResolver();
export const httpClient = new PinnedHttpClient(resolver);
export const eventStream = new EventStream();
export const runtimeRegistry = new RuntimeRegistry();
export const crawlManager = new CrawlManager({
	logger,
	repos: storage.repos,
	eventStream,
	registry: runtimeRegistry,
	resolver,
	httpClient,
});

export const app = new Elysia()
	.use(loggerPlugin(logger))
	.use(dbPlugin(storage))
	.use(securityPlugin(resolver, httpClient))
	.use(
		servicesPlugin({
			crawlManager,
			eventStream,
			runtimeRegistry,
		}),
	)
	.use(
		cors({
			origin: (request) => {
				const origin = request.headers.get("origin");
				if (origin === "http://localhost:5173") {
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
			skip: (request) =>
				request.url.includes("/health") || request.url.includes("/events"),
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

export type App = typeof app;
export { createStartupBanner };

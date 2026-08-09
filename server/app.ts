import { lookup } from "node:dns/promises";
import path from "node:path";
import { cors } from "@elysia/cors";
import { Elysia } from "elysia";
import { type Generator, rateLimit } from "elysia-rate-limit";
import type { Static } from "typebox";
import { API_PATHS } from "../shared/contracts/index.js";
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
import { DefaultResolver, PinnedHttpClient } from "./outbound/HttpClient.js";
import { openapiPlugin } from "./plugins/openapi.js";
import { spaStaticPlugin } from "./plugins/spaStatic.js";
import { CrawlManager } from "./runtime/CrawlManager.js";
import { EventStream } from "./runtime/EventStream.js";
import { createStorage, type Storage } from "./storage/db.js";

const distPath = path.join(import.meta.dir, "..", "dist");

function isRateLimitExempt(request: Request): boolean {
	const pathname = new URL(request.url).pathname;
	return pathname === API_PATHS.health;
}

export interface AppDependencies {
	logger: AppLogger;
	storage: Storage;
	eventStream: EventStream;
	crawlManager: CrawlManager;
	rateLimitGenerator: Generator;
}

export function createDefaultAppDependencies(logger: AppLogger): AppDependencies {
	const storage = createStorage();
	let eventStream: EventStream | undefined;
	try {
		const resolver = new DefaultResolver(lookup, config.allowLocalhostTargets);
		const httpClient = new PinnedHttpClient(resolver);
		eventStream = new EventStream();
		const crawlManager = new CrawlManager({
			logger,
			repos: storage.repos,
			eventStream,
			httpClient,
			storageBudget: storage.budget,
			allowLocalhostSeed: config.allowLocalhostTargets,
		});

		return {
			logger,
			storage,
			eventStream,
			crawlManager,
			rateLimitGenerator: createRateLimitKeyGenerator(config.isRender),
		};
	} catch (error) {
		eventStream?.close();
		storage.close();
		throw error;
	}
}

type SpaRoutes = Awaited<ReturnType<typeof spaStaticPlugin>>;

export function createApp(
	deps: AppDependencies,
	spaRoutes: SpaRoutes | Promise<SpaRoutes> = spaStaticPlugin({ distPath }),
) {
	const routeServices = routeServicesPlugin({
		crawlManager: deps.crawlManager,
		eventStream: deps.eventStream,
		repos: deps.storage.repos,
		resolveClientKey: (request, server) =>
			deps.rateLimitGenerator(request as Parameters<Generator>[0], server, {}),
	});

	const app = new Elysia({ introspect: true })
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
				countFailedRequest: true,
				generator: deps.rateLimitGenerator,
				skip: isRateLimitExempt,
			}),
		)
		.use(openapiPlugin({ interactive: config.isDevelopment }));

	return app
		.use(crawlsApi(routeServices))
		.use(sseApi(routeServices))
		.use(pagesApi(routeServices))
		.use(searchApi(routeServices))
		.use(healthApi(routeServices))
		.use(spaRoutes)
		.error(({ error, logger: requestLogger, status }) => {
			const response = handleAppError({
				error,
				logger: requestLogger,
			});

			return status(response.status, response.body satisfies Static<typeof ApiErrorSchema>);
		});
}

export type App = ReturnType<typeof createApp>;

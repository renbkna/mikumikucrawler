import { lookup } from "node:dns/promises";
import path from "node:path";
import { cors } from "@elysia/cors";
import { Elysia } from "elysia";
import type { Static } from "typebox";
import { API_PATHS } from "../shared/contracts/index.js";
import { routeServicesPlugin } from "./api/context.js";
import { crawlsApi } from "./api/crawls.js";
import { healthApi } from "./api/health.js";
import { searchApi } from "./api/search.js";
import { sseApi } from "./api/sse.js";
import { isCorsOriginAllowed } from "./config/cors.js";
import { config } from "./config/env.js";
import type { AppLogger } from "./config/logging.js";
import { createClientKeyResolver, type RequestTransport } from "./config/rateLimit.js";
import type { ApiErrorSchema } from "./contracts/errors.js";
import { handleAppError } from "./errorHandling.js";
import { DefaultResolver, PinnedHttpClient } from "./outbound/HttpClient.js";
import { openapiModels, openapiPlugin } from "./plugins/openapi.js";
import { rateLimitPlugin } from "./plugins/rateLimit.js";
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
	transport: RequestTransport;
}

export function createDefaultAppDependencies(
	logger: AppLogger,
	transport: RequestTransport,
): AppDependencies {
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
			transport,
		};
	} catch (error) {
		eventStream?.close();
		storage.close();
		throw error;
	}
}

type SpaRoutes = Awaited<ReturnType<typeof spaStaticPlugin>>;

interface AppOptions {
	spaRoutes?: SpaRoutes | Promise<SpaRoutes>;
	/** Serves `/openapi` and `/openapi/json`; the API is documented for development only. */
	exposeApiDocumentation?: boolean;
}

export function createApp(
	deps: AppDependencies,
	{
		spaRoutes = spaStaticPlugin({ distPath }),
		exposeApiDocumentation = config.isDevelopment,
	}: AppOptions = {},
) {
	const resolveClientKey = createClientKeyResolver(config.isRender, deps.transport);
	const routeServices = routeServicesPlugin({
		crawlManager: deps.crawlManager,
		eventStream: deps.eventStream,
		repos: deps.storage.repos,
		resolveClientKey,
		keepOpen: deps.transport.keepOpen,
	});

	const app = new Elysia({ introspect: true })
		.decorate("logger", deps.logger)
		.use(
			cors({
				origin: (request) => isCorsOriginAllowed(request.headers.get("origin"), config),
				credentials: false,
			}),
		)
		.use(
			rateLimitPlugin({
				max: 100,
				windowMs: 60_000,
				maxClients: 10_000,
				clientKey: resolveClientKey,
				isExempt: isRateLimitExempt,
			}),
		)
		.model(openapiModels)
		.use(openapiPlugin({ enabled: exposeApiDocumentation }));

	return app
		.use(crawlsApi(routeServices))
		.use(sseApi(routeServices))
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

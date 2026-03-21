import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cors } from "@elysiajs/cors";
import { staticPlugin } from "@elysiajs/static";
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
import { telemetryPlugin } from "./plugins/telemetry.js";
import { CrawlManager } from "./runtime/CrawlManager.js";
import { EventStream } from "./runtime/EventStream.js";
import { RuntimeRegistry } from "./runtime/RuntimeRegistry.js";
import { createStorage } from "./storage/db.js";
import { getErrorMessage } from "./utils/helpers.js";
import { hashContent } from "./utils/hashUtils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.join(__dirname, "..", "dist");
const distAssetsPath = path.join(distPath, "assets");
const hasDistAssets = existsSync(distAssetsPath);

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
	.use(crawlsApi({ crawlManager, repos: storage.repos }))
	.use(sseApi(eventStream, crawlManager))
	.use(pagesApi(storage.repos))
	.use(searchApi(storage.repos))
	.use(healthApi(runtimeRegistry))
	.use(
		hasDistAssets
			? staticPlugin({ assets: distAssetsPath, prefix: "/assets" })
			: new Elysia(),
	)
	.onError(({ code, error, set }) => {
		if (code === "NOT_FOUND") {
			set.status = 404;
			return { error: "Not Found" };
		}

		logger.error(`[App] ${getErrorMessage(error)}`);
		set.status = 500;
		return {
			error: error instanceof Error ? error.message : "Internal Server Error",
		} satisfies typeof ApiErrorSchema.static;
	})
	.get(
		"*",
		async (context: {
			path: string;
			headers: Record<string, string | undefined>;
		}) => {
			const requestPath = context.path;
			const headers = context.headers;
			if (requestPath.startsWith("/api") || requestPath === "/health") {
				return Response.json({ error: "Not Found" }, { status: 404 });
			}

			const filePath = path.join(distPath, requestPath);
			const file = Bun.file(filePath);
			if (await file.exists()) {
				const isAsset =
					/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/i.test(
						requestPath,
					);

				if (isAsset) {
					const etag = await file
						.arrayBuffer()
						.then((buffer) => hashContent(buffer));
					const ifNoneMatch = headers["if-none-match"];
					if (ifNoneMatch === etag) {
						return new Response(null, { status: 304 });
					}
					return new Response(file, {
						headers: {
							"Content-Type": file.type,
							"Cache-Control": "public, max-age=31536000, immutable",
							ETag: etag,
						},
					});
				}

				return file;
			}

			return Bun.file(path.join(distPath, "index.html"));
		},
	);

export type App = typeof app;
export { createStartupBanner };

/**
 * Miku Crawler API Entry Point
 *
 * Sets up the Elysia server, configures middleware (CORS, Rate Limit, Swagger),
 * initializes the database and logging, and handles graceful shutdown.
 *
 * NOTE: We use Bun's native ESM support.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cors } from "@elysiajs/cors";
import { staticPlugin } from "@elysiajs/static";
import { swagger } from "@elysiajs/swagger";
import { Elysia, t } from "elysia";
import { rateLimit } from "elysia-rate-limit";
import { setupDatabase } from "./config/database.js";
import { config } from "./config/env.js";
import { setupLogging } from "./config/logging.js";
import { createStartupBanner } from "./config/prettyPrinter.js";
import type { CrawlSession } from "./crawler/CrawlSession.js";
import {
	createWebSocketHandlers,
	WebSocketMessageSchema,
} from "./handlers/socketHandlers.js";
import { compression } from "./middleware/compression.js";
import { createApiRoutes } from "./routes/apiRoutes.js";
import { getErrorMessage } from "./utils/helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = await setupLogging();
const db = setupDatabase();
const activeCrawls = new Map<string, CrawlSession>();

logger.info(`Starting Miku Crawler in ${config.env} mode`);
logger.info(`Configured Frontend URL: ${config.frontendUrl}`);
logger.info(`Database Path: ${config.dbPath}`);
if (config.isRender)
	logger.info("Platform: Render.com (Constrained Memory Mode active)");

const FRONTEND_URL = config.frontendUrl;
const PORT = config.port;

// db is a synchronous bun:sqlite Database — no Promise wrapping needed
const { handleMessage, handleClose, dispose } = createWebSocketHandlers(
	activeCrawls,
	db,
	logger,
);

const distPath = path.join(__dirname, "..", "dist");

const app = new Elysia()
	.use(
		cors({
			origin: (request) => {
				const origin = request.headers.get("origin");
				// Only allow Vite's default dev server port
				if (origin === "http://localhost:5173") {
					return true;
				}
				return origin === FRONTEND_URL;
			},
			credentials: true,
		}),
	)
	.use(
		rateLimit({
			max: 100,
			duration: 60_000,
			skip: (request) => {
				const pathname = new URL(request.url).pathname;
				return pathname.startsWith("/ws") || pathname.startsWith("/health");
			},
		}),
	)
	.use(compression())
	.use(
		swagger({
			documentation: {
				info: {
					title: "Miku Crawler API",
					version: "3.0.0",
					description:
						"High-performance web crawler API with real-time WebSocket updates.",
				},
				tags: [
					{ name: "Stats", description: "System and crawler statistics" },
					{ name: "Content", description: "Crawled page content access" },
					{ name: "System", description: "Server health and diagnostics" },
				],
			},
		}),
	)
	.use(
		staticPlugin({
			assets: path.join(distPath, "assets"),
			prefix: "/assets",
		}),
	)
	.use(createApiRoutes(db, logger, activeCrawls))
	.ws("/ws", {
		body: WebSocketMessageSchema,
		open(ws) {
			// ws.id is Elysia's stable socket identifier (NOT ws.data.id)
			logger.info(`Client connected: ${ws.id}`);
		},
		// The handlers use structural types ({ id, send }) that are a supertype
		// of Elysia's full WS context, which is valid at runtime. The casts are
		// required because TypeScript's strict function parameter checking cannot
		// verify the structural compatibility with Elysia's deeply-generic WS type.
		// biome-ignore lint/suspicious/noExplicitAny: Elysia WS structural type compat
		message: handleMessage as any,
		// biome-ignore lint/suspicious/noExplicitAny: Elysia WS structural type compat
		close: handleClose as any,
	})
	.get(
		"/health",
		() => ({
			status: "ok",
			activeCrawls: activeCrawls.size,
			uptime: process.uptime(),
		}),
		{
			detail: {
				tags: ["System"],
				summary: "Health check",
				description:
					"Returns server status, number of active crawls, and process uptime.",
			},
			response: t.Object({
				status: t.String(),
				activeCrawls: t.Number(),
				uptime: t.Number(),
			}),
		},
	)
	.onError(({ code, error, set }) => {
		if (code === "VALIDATION") {
			set.status = 422;
			return { error: getErrorMessage(error) };
		}
		if (code === "PARSE") {
			set.status = 400;
			return { error: "Invalid request body" };
		}
		set.status = 500;
		logger.error(`Global Error [${code}]: ${error}`);
		return { error: getErrorMessage(error) };
	})
	.get(
		"*",
		async ({ path: reqPath, request }: { path: string; request: Request }) => {
			const filePath = path.join(distPath, reqPath);
			const file = Bun.file(filePath);
			if (await file.exists()) {
				// Add cache headers for static assets
				const isAsset =
					/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/i.test(
						reqPath,
					);
				if (isAsset) {
					// Use file metadata for cheap ETag (avoids reading full file into memory)
					const etag = `${file.size}-${file.lastModified}`;
					const ifNoneMatch = request.headers?.get?.("if-none-match") ?? null;
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

			if (reqPath.startsWith("/api")) {
				return Response.json({ error: "Not Found" }, { status: 404 });
			}

			return Bun.file(path.join(distPath, "index.html"));
		},
	);

const instance = app.listen(PORT, (server) => {
	// biome-ignore lint/suspicious/noConsole: Startup banner is intentional output
	console.log(
		createStartupBanner({
			port: server.port ?? PORT,
			frontendUrl: FRONTEND_URL,
			env: config.env,
		}),
	);
});

/**
 * Ensures clean teardown of database connections and active crawl sessions
 * on process termination (SIGTERM/SIGINT).
 */
async function gracefulShutdown(signal: string): Promise<void> {
	logger.info(`${signal} received, shutting down gracefully`);

	// Stop the rate-limiter cleanup interval
	dispose();

	for (const session of activeCrawls.values()) {
		try {
			await session.stop();
		} catch (error) {
			logger.error(`Error stopping crawl session: ${getErrorMessage(error)}`);
		}
	}

	try {
		db.close();
		logger.info("Database connection closed");
	} catch (error) {
		logger.warn(`Failed to close database cleanly: ${getErrorMessage(error)}`);
	}

	await instance.stop();
	logger.info("Server closed");
	logger.close();
	process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export type App = typeof app;

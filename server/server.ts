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
import { Elysia } from "elysia";
import { rateLimit } from "elysia-rate-limit";
import { setupDatabase } from "./config/database.js";
import { config } from "./config/env.js";
import { setupLogging } from "./config/logging.js";
import type { CrawlSession } from "./crawler/CrawlSession.js";
import {
	createWebSocketHandlers,
	WebSocketMessageSchema,
} from "./handlers/socketHandlers.js";
import { apiRoutes } from "./routes/apiRoutes.js";
import { getErrorMessage } from "./utils/helpers.js";

// Bun natively loads .env files - no dotenv needed

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

// Pass the database as a Promise to handlers that might need async access (e.g., inside closures)
const { handleMessage, handleClose } = createWebSocketHandlers(
	activeCrawls,
	Promise.resolve(db),
	logger,
);

const distPath = path.join(__dirname, "..", "dist");

const app = new Elysia()
	.decorate("db", db)
	.decorate("logger", logger)
	.decorate("activeCrawls", activeCrawls)
	.use(
		cors({
			origin: (request) => {
				const origin = request.headers.get("origin");
				if (origin?.startsWith("http://localhost:517")) {
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
			skip: (request) =>
				request.url.includes("/ws") || request.url.includes("/health"),
		}),
	)
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
	.use(apiRoutes)
	.ws("/ws", {
		body: WebSocketMessageSchema,
		// biome-ignore lint/suspicious/noExplicitAny: Elysia WS types mismatch
		open(ws: any) {
			logger.info(`Client connected: ${ws.id}`);
		},
		// biome-ignore lint/suspicious/noExplicitAny: Elysia WS types mismatch
		message: handleMessage as any,
		// biome-ignore lint/suspicious/noExplicitAny: Elysia WS types mismatch
		close: handleClose as any,
	})
	.get("/health", () => ({
		status: "ok",
		activeCrawls: activeCrawls.size,
		uptime: process.uptime(),
		memoryUsage: process.memoryUsage(),
	}))
	.onError(({ code, error, set }) => {
		if (code === "NOT_FOUND") {
			set.status = 404;
			return { error: "Not Found" };
		}
		logger.error(`Global Error: ${error}`);
		const errorMessage = (error as Error)?.message || "Internal Server Error";
		return { error: errorMessage };
	})
	.get("*", async ({ path: reqPath }) => {
		const filePath = path.join(distPath, reqPath);
		const file = Bun.file(filePath);
		if (await file.exists()) {
			return file;
		}

		if (reqPath.startsWith("/api")) {
			return Response.json({ error: "Not Found" }, { status: 404 });
		}

		return Bun.file(path.join(distPath, "index.html"));
	});

const instance = app.listen(PORT, (server) => {
	logger.info(`Miku Crawler backend running on port ${server.port} (Elysia)`);
	logger.info(
		`Swagger documentation available at http://localhost:${server.port}/swagger`,
	);
});

/**
 * Ensures clean teardown of database connections and active crawl sessions
 * on process termination (SIGTERM/SIGINT).
 */
async function gracefulShutdown(signal: string): Promise<void> {
	logger.info(`${signal} received, shutting down gracefully`);

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

	instance.stop();
	logger.info("Server closed");
	logger.close();
	process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export type App = typeof app;

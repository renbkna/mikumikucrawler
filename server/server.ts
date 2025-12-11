import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import compression from "compression";
import cors from "cors";
import dotenv from "dotenv";
import express, { type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { Server } from "socket.io";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { setupDatabase } from "./config/database.js";
import { setupLogging } from "./config/logging.js";
import { setupSocketHandlers } from "./handlers/socketHandlers.js";
import { setupApiRoutes } from "./routes/apiRoutes.js";

const logger = await setupLogging();
const dbPromise = setupDatabase();

const app = express();
const server = http.createServer(app);
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const io = new Server(server, {
	cors: {
		origin: FRONTEND_URL,
		methods: ["GET", "POST"],
		credentials: true,
	},
	maxHttpBufferSize: 5e6, // 5MB
	pingTimeout: 60000,
});

app.use(
	cors({
		origin: FRONTEND_URL,
		credentials: true,
	}),
);
app.use(
	helmet({
		contentSecurityPolicy: false, // Disable CSP for SPA compatibility; configure as needed
	}),
);
app.use(compression());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

const globalLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 1000,
	standardHeaders: true,
	legacyHeaders: false,
	message: { error: "Too many requests, please try again later." },
});
app.use(globalLimiter);

const activeCrawls = setupSocketHandlers(io, dbPromise, logger);
const apiRoutes = setupApiRoutes(dbPromise, activeCrawls, logger);

app.use("/api", apiRoutes);
app.get("/health", (_req: Request, res: Response) => {
	res.json({
		status: "ok",
		activeCrawls: activeCrawls.size,
		uptime: process.uptime(),
		memoryUsage: process.memoryUsage(),
	});
});

// Serve the built React frontend in production
const distPath = path.join(__dirname, "..", "dist");
app.use(express.static(distPath));

// SPA catch-all route: serves index.html for any non-API route
app.get("{*splat}", (_req: Request, res: Response) => {
	res.sendFile(path.join(distPath, "index.html"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
	logger.info(`Advanced Miku Crawler Beam backend running on port ${PORT}`);
});

async function gracefulShutdown(signal: string): Promise<void> {
	logger.info(`${signal} received, shutting down gracefully`);

	for (const session of activeCrawls.values()) {
		try {
			await session.stop();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`Error stopping crawl session: ${message}`);
		}
	}

	try {
		const db = await dbPromise;
		db.close();
		logger.info("Database connection closed");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn(`Failed to close database cleanly: ${message}`);
	}

	server.close(() => {
		logger.info("Server closed");
		logger.close();
		process.exit(0);
	});
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export default app;

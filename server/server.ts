import {
	app,
	crawlManager,
	createStartupBanner,
	logger,
	storage,
} from "./app.js";
import { config } from "./config/env.js";

const instance = app.listen(config.port, (server) => {
	// biome-ignore lint/suspicious/noConsole: startup banner is intentional output
	console.log(
		createStartupBanner({
			port: server.port ?? config.port,
			frontendUrl: config.frontendUrl,
			env: config.env,
		}),
	);
});

let isShuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
	if (isShuttingDown) return;
	isShuttingDown = true;
	logger.info(`${signal} received, shutting down gracefully`);
	await crawlManager.shutdownAll();
	await instance.stop();
	storage.db.close();
	logger.close();
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

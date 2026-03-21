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

async function gracefulShutdown(signal: string): Promise<void> {
	logger.info(`${signal} received, shutting down gracefully`);
	await crawlManager.shutdownAll();
	instance.stop();
	storage.db.close();
	logger.close();
	process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

export type App = typeof app;

import { createApp, createDefaultAppDependencies } from "./app.js";
import { config } from "./config/env.js";
import { createServerListenOptions } from "./config/listen.js";
import { setupLogging } from "./config/logging.js";

const logger = await setupLogging();
const dependencies = createDefaultAppDependencies(logger);
const app = createApp(dependencies);
const crawlManager = dependencies.crawlManager;

const instance = await (async () => {
	try {
		const listeningApp = app.listen(createServerListenOptions(config.port));
		crawlManager.recoverOrphanedActiveCrawls();
		logger.info(
			{
				port: listeningApp.server?.port ?? config.port,
				frontendUrl: config.frontendUrl,
				env: config.env,
			},
			"server started",
		);
		return listeningApp;
	} catch (error) {
		logger.fatal({ error, port: config.port }, "server failed to start");
		if (app.server) {
			await app.stop(true);
		}
		dependencies.storage.db.close();
		logger.close();
		process.exit(1);
	}
})();

let isShuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
	if (isShuttingDown) return;
	isShuttingDown = true;
	logger.info(`${signal} received, shutting down gracefully`);
	await crawlManager.shutdownAll();
	await instance.stop();
	dependencies.storage.db.close();
	logger.close();
	process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

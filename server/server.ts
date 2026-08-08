import { Elysia, status } from "elysia";
import { type AppDependencies, createApp, createDefaultAppDependencies } from "./app.js";
import { config } from "./config/env.js";
import { createServerListenOptions } from "./config/listen.js";
import { setupLogging } from "./config/logging.js";

const logger = await setupLogging();
const started = await (async () => {
	let dependencies: AppDependencies | undefined;
	let applicationApp: ReturnType<typeof createApp> | undefined;
	const listenerOwned = Promise.withResolvers<void>();
	const application = listenerOwned.promise.then(async () => {
		dependencies = createDefaultAppDependencies(logger);
		const app = createApp(dependencies);
		await app.modules;
		return app;
	});
	const bootstrap = new Elysia().all("*", ({ request, server }) => {
		if (!applicationApp) return status(503, { error: "Server is starting" });
		return applicationApp.fetch(request, server);
	});

	try {
		const listeningApp = bootstrap.listen(
			createServerListenOptions(config.port, config.allowLocalhostTargets),
		);
		listenerOwned.resolve();
		applicationApp = await application;
		if (!dependencies) throw new Error("Application dependencies did not initialize");
		dependencies.crawlManager.recoverOrphanedActiveCrawls();
		logger.info(
			{
				port: listeningApp.server?.port ?? config.port,
				frontendOrigin: config.frontendOrigin,
				env: config.env,
			},
			"server started",
		);
		return { dependencies, instance: listeningApp };
	} catch (error) {
		logger.fatal({ error, port: config.port }, "server failed to start");
		if (bootstrap.server) await bootstrap.stop(true);
		dependencies?.eventStream.close();
		dependencies?.storage.close();
		process.exit(1);
	}
})();

const { dependencies, instance } = started;
const crawlManager = dependencies.crawlManager;

let isShuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
	if (isShuttingDown) return;
	isShuttingDown = true;
	logger.info(`${signal} received, shutting down gracefully`);
	const listenerDrain = instance.stop();
	await crawlManager.shutdownAll();
	dependencies.eventStream.close();
	await listenerDrain;
	dependencies.storage.close();
	process.exitCode = 0;
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

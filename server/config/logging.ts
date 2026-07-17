import pino, { type Logger } from "pino";
import { config } from "./env.js";

export type { Logger } from "pino";
export type AppLogger = Logger;

/**
 * Production logs have one owner: structured JSON on stdout for the platform
 * collector. Development keeps the same stream but renders it for humans.
 */
export const setupLogging = async (): Promise<AppLogger> => {
	const destination = config.isProduction
		? process.stdout
		: (await import("pino-pretty")).default({ colorize: true });

	return pino(
		{
			level: config.logLevel,
			base: { service: "miku-crawler" },
			timestamp: pino.stdTimeFunctions.isoTime,
		},
		destination,
	);
};

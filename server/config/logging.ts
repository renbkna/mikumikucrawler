import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import pino, { type Logger } from "pino";
import { config } from "./env.js";

const ensureDirectoryExists = (dir: string): void => {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
};

/** Re-export Logger type for consumers */
export type { Logger } from "pino";

/**
 * Extended logger interface with close method for graceful shutdown.
 * Pino doesn't have a native close method, so we add one for file stream cleanup.
 */
export interface AppLogger extends Logger {
	close(): void;
}

/**
 * Sets up Pino logger with console output (pretty-printed) and file transports.
 * Pino is ~5x faster than Winston with lower memory footprint.
 */
export const setupLogging = async (): Promise<AppLogger> => {
	ensureDirectoryExists("./logs");

	const level = config.logLevel;

	// Create file streams for log destinations
	const errorStream = createWriteStream("./logs/error.log", { flags: "a" });
	const allStream = createWriteStream("./logs/crawler.log", { flags: "a" });

	const isProduction = config.isProduction;

	// Create multi-stream transport using pino.multistream
	const streams = pino.multistream([
		// Console output
		{
			level: "debug",
			stream: isProduction
				? process.stdout
				: pino.transport({
						target: "pino-pretty",
						options: {
							colorize: true,
							translateTime: "HH:MM:ss",
							ignore: "pid,hostname",
							levelFirst: true,
						},
					}),
		},
		// All logs to crawler.log (JSON format for parsing)
		{ level: "debug", stream: allStream },
		// Error-only logs to error.log
		{ level: "error", stream: errorStream },
	]);

	const logger = pino(
		{
			level,
			base: { service: "miku-crawler" },
			timestamp: pino.stdTimeFunctions.isoTime,
		},
		streams,
	) as AppLogger;

	// Add close method for graceful shutdown
	logger.close = () => {
		errorStream.end();
		allStream.end();
	};

	return logger;
};

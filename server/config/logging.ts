import { existsSync, mkdir } from "node:fs";
import { promisify } from "node:util";
import winston, { type Logger } from "winston";

// Promisify mkdir
const mkdirAsync = promisify(mkdir);

// Ensure directories exist
const ensureDirectoryExists = async (dir: string): Promise<void> => {
	if (!existsSync(dir)) {
		await mkdirAsync(dir, { recursive: true });
	}
};

// SETUP: Logging (Winston) - improved with daily rotation and better formatting
export const setupLogging = async (): Promise<Logger> => {
	await ensureDirectoryExists("./logs");

	return winston.createLogger({
		level: process.env.LOG_LEVEL || "info",
		format: winston.format.combine(
			winston.format.timestamp(),
			winston.format.errors({ stack: true }),
			winston.format.splat(),
			winston.format.json(),
		),
		defaultMeta: { service: "miku-crawler" },
		transports: [
			new winston.transports.Console({
				format: winston.format.combine(
					winston.format.colorize(),
					winston.format.printf(({ timestamp, level, message, ...rest }) => {
						return `${timestamp} ${level}: ${message} ${
							Object.keys(rest).length ? JSON.stringify(rest, null, 2) : ""
						}`;
					}),
				),
			}),
			new winston.transports.File({
				filename: "logs/error.log",
				level: "error",
				maxsize: 10485760, // 10MB
				maxFiles: 5,
			}),
			new winston.transports.File({
				filename: "logs/crawler.log",
				maxsize: 10485760, // 10MB
				maxFiles: 10,
			}),
		],
	});
};

import { existsSync, mkdir } from "node:fs";
import { promisify } from "node:util";
import winston, { type Logger } from "winston";

const mkdirAsync = promisify(mkdir);

const ensureDirectoryExists = async (dir: string): Promise<void> => {
	if (!existsSync(dir)) {
		await mkdirAsync(dir, { recursive: true });
	}
};

// ANSI color codes for professional output
const colors = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	cyan: "\x1b[36m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	magenta: "\x1b[35m",
	gray: "\x1b[90m",
};

const levelStyles: Record<string, { color: string; label: string }> = {
	error: { color: colors.red, label: "ERR" },
	warn: { color: colors.yellow, label: "WRN" },
	info: { color: colors.cyan, label: "INF" },
	debug: { color: colors.magenta, label: "DBG" },
	verbose: { color: colors.gray, label: "VRB" },
};

const formatTime = (): string => {
	const now = new Date();
	return [
		String(now.getHours()).padStart(2, "0"),
		String(now.getMinutes()).padStart(2, "0"),
		String(now.getSeconds()).padStart(2, "0"),
	].join(":");
};

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
				format: winston.format.printf(({ level, message, stack }) => {
					// Strip ANSI codes from level to get raw name
					const rawLevel = level.replaceAll(/\u001b\[[0-9;]*m/gu, "");
					const style = levelStyles[rawLevel] || {
						color: colors.gray,
						label: "LOG",
					};

					const time = `${colors.dim}${formatTime()}${colors.reset}`;
					const tag = `${style.color}${colors.bold}${style.label}${colors.reset}`;

					// Format: HH:MM:SS TAG message
					let output = `${time} ${tag} ${message}`;

					// Add stack trace for errors
					if (stack && typeof stack === "string") {
						output += `\n${colors.dim}${stack}${colors.reset}`;
					}

					return output;
				}),
			}),
			new winston.transports.File({
				filename: "logs/error.log",
				level: "error",
				maxsize: 10485760,
				maxFiles: 5,
			}),
			new winston.transports.File({
				filename: "logs/crawler.log",
				maxsize: 10485760,
				maxFiles: 10,
			}),
		],
	});
};

/**
 * Centralized Environment Configuration
 *
 * This module ensures all environment variables are validated and
 * provides a single source of truth for the backend.
 */

const getEnv = (key: string, defaultValue: string): string => {
	return process.env[key] || defaultValue;
};

/**
 * Parses a required numeric environment variable.
 * Throws a clear startup error (rather than silently using NaN) when the
 * value is missing or not a valid integer.
 */
function requireInt(key: string, defaultValue: number): number {
	const raw = process.env[key];
	if (raw === undefined || raw === "") return defaultValue;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed)) {
		throw new Error(
			`Invalid environment variable ${key}="${raw}" — expected an integer (default: ${defaultValue}).`,
		);
	}
	return parsed;
}

const port = requireInt("PORT", 3000);
if (port < 1 || port > 65535) {
	throw new Error(`Invalid PORT=${port} — must be between 1 and 65535.`);
}

const isRender = getEnv("RENDER", "false") === "true";
const memoryThreshold = requireInt("MEMORY_THRESHOLD_MB", isRender ? 350 : 600);

export const config = {
	env: getEnv("NODE_ENV", "development"),
	isProduction: process.env.NODE_ENV === "production",
	port,
	frontendUrl: getEnv("FRONTEND_URL", "http://localhost:5173"),
	dbPath: getEnv("DB_PATH", "./data/crawler.db"),
	logLevel: getEnv("LOG_LEVEL", "info"),
	userAgent: getEnv("USER_AGENT", "MikuCrawler/3.0.0"),
	isRender,
	// Memory threshold in MB for low memory detection (default: 350MB for Render, 600MB otherwise)
	memoryThreshold,
	browser: {
		executablePath:
			process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
			process.env.PUPPETEER_EXECUTABLE_PATH ||
			process.env.CHROME_BIN ||
			undefined,
	},
} as const;

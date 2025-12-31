/**
 * Centralized Environment Configuration
 *
 * This module ensures all environment variables are validated and
 * provides a single source of truth for the backend.
 */

const getEnv = (key: string, defaultValue: string): string => {
	return process.env[key] || defaultValue;
};

export const config = {
	env: getEnv("NODE_ENV", "development"),
	isProduction: process.env.NODE_ENV === "production",
	port: Number.parseInt(getEnv("PORT", "3000"), 10),
	frontendUrl: getEnv("FRONTEND_URL", "http://localhost:5173"),
	dbPath: getEnv("DB_PATH", "./data/crawler.db"),
	logLevel: getEnv("LOG_LEVEL", "info"),
	userAgent: getEnv("USER_AGENT", "MikuCrawler/3.0.0"),
	isRender: getEnv("RENDER", "false") === "true",
	puppeteer: {
		executablePath:
			process.env.PUPPETEER_EXECUTABLE_PATH ||
			process.env.CHROME_BIN ||
			undefined,
	},
} as const;

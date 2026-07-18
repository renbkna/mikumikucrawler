/**
 * Centralized Environment Configuration
 *
 * This module ensures all environment variables are validated and
 * provides a single source of truth for the backend.
 */

import { resolveBackendPort } from "../../shared/deploymentDefaults.js";

const getEnv = (key: string, defaultValue: string): string => {
	return process.env[key] || defaultValue;
};

const ROBOTS_PRODUCT_TOKEN_PATTERN = /^[A-Za-z_-]+$/;
const SIMPLE_USER_AGENT_PATTERN = /^([A-Za-z_-]+)(?:\/[^\s()]+)?$/;

export function resolveRobotsProductToken(userAgent: string, configuredToken?: string): string {
	const explicitToken = configuredToken?.trim();
	if (explicitToken) {
		if (!ROBOTS_PRODUCT_TOKEN_PATTERN.test(explicitToken)) {
			throw new Error(
				`Invalid ROBOTS_PRODUCT_TOKEN="${configuredToken}" — expected letters, underscores, or hyphens.`,
			);
		}
		return explicitToken;
	}

	const inferredToken = SIMPLE_USER_AGENT_PATTERN.exec(userAgent.trim())?.[1];
	if (inferredToken) return inferredToken;

	throw new Error(
		"ROBOTS_PRODUCT_TOKEN is required when USER_AGENT is not a single product token with an optional version.",
	);
}

/**
 * Parses a required numeric environment variable.
 * Throws a clear startup error (rather than silently using NaN) when the
 * value is missing or not a valid integer.
 */
function requireInt(key: string, defaultValue: number): number {
	const raw = process.env[key];
	if (raw === undefined || raw === "") return defaultValue;
	const normalized = raw.trim();
	if (!/^-?\d+$/.test(normalized)) {
		throw new Error(
			`Invalid environment variable ${key}="${raw}" — expected an integer (default: ${defaultValue}).`,
		);
	}
	return Number.parseInt(normalized, 10);
}

const port = resolveBackendPort(process.env.PORT);

const isRender = getEnv("RENDER", "false") === "true";
const memoryThreshold = requireInt("MEMORY_THRESHOLD_MB", isRender ? 350 : 600);
if (memoryThreshold < 1) {
	throw new Error(`Invalid MEMORY_THRESHOLD_MB=${memoryThreshold} — must be at least 1.`);
}
const env = getEnv("NODE_ENV", "development");
const userAgent = getEnv("USER_AGENT", "MikuCrawler/3.0.0");
const robotsProductToken = resolveRobotsProductToken(userAgent, process.env.ROBOTS_PRODUCT_TOKEN);

export function allowsLocalhostTargets(environment: string): boolean {
	return environment === "development";
}

export const config = {
	env,
	isDevelopment: allowsLocalhostTargets(env),
	isProduction: env === "production",
	allowLocalhostTargets: allowsLocalhostTargets(env),
	port,
	frontendUrl: getEnv("FRONTEND_URL", "http://localhost:5173"),
	dbPath: getEnv("DB_PATH", "./data/crawler.db"),
	logLevel: getEnv("LOG_LEVEL", "info"),
	userAgent,
	robotsProductToken,
	isRender,
	// Memory threshold in MB for low memory detection (default: 350MB for Render, 600MB otherwise)
	memoryThreshold,
	browser: {
		executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
	},
} as const;

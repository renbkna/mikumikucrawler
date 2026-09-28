/**
 * Centralized Environment Configuration
 *
 * This module ensures all environment variables are validated and
 * provides a single source of truth for the backend.
 */

import packageJson from "../../package.json" with { type: "json" };
import { parseIntegerSetting, resolveBackendPort } from "../../shared/deploymentDefaults.js";

const getEnv = (key: string, defaultValue: string): string => {
	return process.env[key] || defaultValue;
};

const ROBOTS_PRODUCT_TOKEN_PATTERN = /^[A-Za-z_-]+$/;
const SIMPLE_USER_AGENT_PATTERN = /^([A-Za-z_-]+)(?:\/[^\s()]+)?$/;
export const MAX_MEMORY_THRESHOLD_MB = 1024 * 1024;
export const MAX_STORAGE_BUDGET_MB = 1024 * 1024;

function userAgentContainsProductToken(userAgent: string, productToken: string): boolean {
	return new RegExp(
		`(?:^|[\\s(;])${RegExp.escape(productToken)}(?:/[^\\s();]+)?(?=$|[\\s;)])`,
		"i",
	).test(userAgent);
}

export function resolveRobotsProductToken(userAgent: string, configuredToken?: string): string {
	const explicitToken = configuredToken?.trim();
	if (explicitToken) {
		if (!ROBOTS_PRODUCT_TOKEN_PATTERN.test(explicitToken)) {
			throw new Error(
				`Invalid ROBOTS_PRODUCT_TOKEN="${configuredToken}" — expected letters, underscores, or hyphens.`,
			);
		}
		if (!userAgentContainsProductToken(userAgent, explicitToken)) {
			throw new Error(
				`Invalid ROBOTS_PRODUCT_TOKEN="${configuredToken}" — it must identify a product token present in USER_AGENT.`,
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

function requireBoolean(key: string, defaultValue: boolean): boolean {
	const raw = process.env[key];
	if (raw === undefined || raw === "") return defaultValue;
	if (raw === "true") return true;
	if (raw === "false") return false;
	throw new Error(`Invalid environment variable ${key}="${raw}" — expected "true" or "false".`);
}

export function parseFrontendOrigin(raw: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch (error) {
		throw new Error(`Invalid FRONTEND_URL="${raw}" — expected an absolute HTTP(S) origin.`, {
			cause: error,
		});
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Invalid FRONTEND_URL="${raw}" — expected an HTTP(S) origin.`);
	}
	if (parsed.username || parsed.password) {
		throw new Error(`Invalid FRONTEND_URL="${raw}" — credentials are not allowed.`);
	}
	if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
		throw new Error(
			`Invalid FRONTEND_URL="${raw}" — paths, queries, and fragments are not allowed.`,
		);
	}

	return parsed.origin;
}

const port = resolveBackendPort(process.env.PORT);

const isRender = requireBoolean("RENDER", false);
const memoryThreshold = parseIntegerSetting(
	"MEMORY_THRESHOLD_MB",
	process.env.MEMORY_THRESHOLD_MB,
	isRender ? 350 : 600,
	{ min: 1, max: MAX_MEMORY_THRESHOLD_MB },
);
const storageBudgetMb = parseIntegerSetting("MAX_STORAGE_MB", process.env.MAX_STORAGE_MB, 2048, {
	min: 1,
	max: MAX_STORAGE_BUDGET_MB,
});
const env = getEnv("NODE_ENV", "development");
const userAgent = getEnv("USER_AGENT", `MikuCrawler/${packageJson.version}`);
const robotsProductToken = resolveRobotsProductToken(userAgent, process.env.ROBOTS_PRODUCT_TOKEN);
const frontendOrigin = parseFrontendOrigin(getEnv("FRONTEND_URL", "http://localhost:5173"));

export function allowsLocalhostTargets(environment: string): boolean {
	return environment === "development";
}

export const config = {
	env,
	isDevelopment: allowsLocalhostTargets(env),
	isProduction: env === "production",
	allowLocalhostTargets: allowsLocalhostTargets(env),
	port,
	frontendOrigin,
	dbPath: getEnv("DB_PATH", "./data/crawler.db"),
	logLevel: getEnv("LOG_LEVEL", "info"),
	userAgent,
	robotsProductToken,
	isRender,
	// Browser-rendering RSS admission threshold (350MB on Render, 600MB elsewhere).
	memoryThreshold,
	maxStorageBytes: storageBudgetMb * 1024 * 1024,
	browser: {
		executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
	},
} as const;

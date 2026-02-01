import { config } from "../config/env.js";
import type { DatabaseLike, LoggerLike } from "../types.js";

/**
 * Extracts a message from an unknown error value.
 * Use this instead of inline `err instanceof Error ? err.message : String(error)` checks.
 */
export function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return String(error);
}

const ROBOTS_CACHE_MAX_SIZE = 100;
const ROBOTS_CACHE_TTL_MS = 60 * 60 * 1000;

interface Rule {
	userAgent: string;
	allow: string[];
	disallow: string[];
	crawlDelay?: number;
}

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

interface RobotsResult {
	isAllowed(url: string, userAgent?: string): boolean | undefined;
	isDisallowed(url: string, userAgent?: string): boolean | undefined;
	getCrawlDelay(userAgent?: string): number | undefined;
	getSitemaps(): string[];
}

class NativeRobotsParser implements RobotsResult {
	private rules: Rule[] = [];
	private sitemaps: string[] = [];

	constructor(robotsTxt: string) {
		this.parse(robotsTxt);
	}

	private parse(robotsTxt: string): void {
		const lines = robotsTxt.split("\n");
		let currentRule: Rule | null = null;

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			const colonIndex = trimmed.indexOf(":");
			if (colonIndex === -1) continue;

			const directive = trimmed.slice(0, colonIndex).trim().toLowerCase();
			const value = trimmed.slice(colonIndex + 1).trim();

			switch (directive) {
				case "user-agent":
					if (currentRule) {
						this.rules.push(currentRule);
					}
					currentRule = {
						userAgent: value.toLowerCase(),
						allow: [],
						disallow: [],
					};
					break;
				case "allow":
					if (currentRule) {
						currentRule.allow.push(value);
					}
					break;
				case "disallow":
					if (currentRule) {
						currentRule.disallow.push(value);
					}
					break;
				case "crawl-delay":
					if (currentRule) {
						currentRule.crawlDelay = parseFloat(value);
					}
					break;
				case "sitemap":
					this.sitemaps.push(value);
					break;
			}
		}

		if (currentRule) {
			this.rules.push(currentRule);
		}
	}

	private matchesRule(path: string, pattern: string): boolean {
		// Convert robots.txt pattern to regex
		// * matches any sequence of characters
		// $ matches end of string
		const regexPattern = pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*/g, ".*")
			.replace(/\$/g, "$");

		try {
			const regex = new RegExp(regexPattern);
			return regex.test(path);
		} catch {
			return path.startsWith(pattern);
		}
	}

	private getPathFromUrl(url: string): string {
		try {
			return new URL(url).pathname;
		} catch {
			// If it's already a path, return as-is
			return url.startsWith("/") ? url : `/${url}`;
		}
	}

	private findMatchingRule(userAgent?: string): Rule | null {
		if (!userAgent) {
			// Return * rule if exists
			return this.rules.find((r) => r.userAgent === "*") || null;
		}

		const ua = userAgent.toLowerCase();
		// First try exact match
		let rule = this.rules.find((r) => r.userAgent === ua);
		if (rule) return rule;

		// Try partial match
		rule = this.rules.find((r) => ua.includes(r.userAgent));
		if (rule) return rule;

		// Return * rule as fallback
		return this.rules.find((r) => r.userAgent === "*") || null;
	}

	isAllowed(url: string, userAgent?: string): boolean {
		const path = this.getPathFromUrl(url);
		const rule = this.findMatchingRule(userAgent);

		if (!rule) return true;

		// Check explicit allows first
		for (const allowPattern of rule.allow) {
			if (this.matchesRule(path, allowPattern)) {
				return true;
			}
		}

		// Then check disallows
		for (const disallowPattern of rule.disallow) {
			if (this.matchesRule(path, disallowPattern)) {
				return false;
			}
		}

		return true;
	}

	isDisallowed(url: string, userAgent?: string): boolean {
		return !this.isAllowed(url, userAgent);
	}

	getCrawlDelay(userAgent?: string): number | undefined {
		const rule = this.findMatchingRule(userAgent);
		return rule?.crawlDelay;
	}

	getSitemaps(): string[] {
		return [...this.sitemaps];
	}
}

class RobotsCache {
	private cache: Map<string, CacheEntry<RobotsResult>>;
	private maxSize: number;
	private ttlMs: number;

	constructor(maxSize = ROBOTS_CACHE_MAX_SIZE, ttlMs = ROBOTS_CACHE_TTL_MS) {
		this.cache = new Map();
		this.maxSize = maxSize;
		this.ttlMs = ttlMs;
	}

	has(domain: string): boolean {
		const entry = this.cache.get(domain);
		if (!entry) return false;

		if (Date.now() > entry.expiresAt) {
			this.cache.delete(domain);
			return false;
		}
		return true;
	}

	get(domain: string): RobotsResult | undefined {
		const entry = this.cache.get(domain);
		if (!entry) return undefined;

		if (Date.now() > entry.expiresAt) {
			this.cache.delete(domain);
			return undefined;
		}
		return entry.value;
	}

	set(domain: string, value: RobotsResult): void {
		if (this.cache.size >= this.maxSize) {
			const oldestKey = this.cache.keys().next().value;
			if (oldestKey) {
				this.cache.delete(oldestKey);
			}
		}

		this.cache.set(domain, {
			value,
			expiresAt: Date.now() + this.ttlMs,
		});
	}

	clear(): void {
		this.cache.clear();
	}
}

const robotsCache = new RobotsCache();

interface RobotsOptions {
	allowOnFailure?: boolean;
}

/**
 * Fetches and parses robots.txt for a domain with database persistence and TTL-based caching.
 *
 * Strategy:
 * 1. Check in-memory cache.
 * 2. Check database.
 * 3. Fetch from network (trying HTTPS then HTTP).
 * 4. On failure, optionally allow all (default).
 */
export async function getRobotsRules(
	domain: string,
	dbPromise: Promise<DatabaseLike>,
	logger: LoggerLike,
	{ allowOnFailure = true }: RobotsOptions = {},
): Promise<RobotsResult | null> {
	if (robotsCache.has(domain)) {
		return robotsCache.get(domain) ?? null;
	}

	try {
		const db = await dbPromise;
		const domainSettings = db
			.query("SELECT robots_txt FROM domain_settings WHERE domain = ?")
			.get(domain) as { robots_txt?: string } | undefined;

		if (domainSettings?.robots_txt) {
			const robots = new NativeRobotsParser(domainSettings.robots_txt);
			robotsCache.set(domain, robots);
			return robots;
		}

		const protocols = ["https", "http"];
		let robotsTxt: string | null = null;
		let lastError: Error | null = null;

		for (const protocol of protocols) {
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 5000);

				const response = await fetch(`${protocol}://${domain}/robots.txt`, {
					signal: controller.signal,
					headers: {
						"User-Agent": config.userAgent,
					},
					redirect: "follow",
				});

				clearTimeout(timeoutId);

				if (!response.ok) {
					throw new Error(`HTTP error! status: ${response.status}`);
				}

				robotsTxt = await response.text();
				break;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
			}
		}

		if (!robotsTxt) {
			logger.warn(
				`Failed to download robots.txt for ${domain}: ${lastError?.message || "unknown error"}`,
			);
			if (!allowOnFailure) {
				return null;
			}
			const fallback = new NativeRobotsParser("");
			robotsCache.set(domain, fallback);
			return fallback;
		}

		const robots = new NativeRobotsParser(robotsTxt);

		db.query(
			"INSERT OR REPLACE INTO domain_settings (domain, robots_txt) VALUES (?, ?)",
		).run(domain, robotsTxt);

		robotsCache.set(domain, robots);
		return robots;
	} catch (err) {
		const message = err instanceof Error ? err.message : "Unknown error";
		logger.warn(`Failed to get robots.txt for ${domain}: ${message}`);
		if (!allowOnFailure) {
			return null;
		}
		const fallback = new NativeRobotsParser("");
		robotsCache.set(domain, fallback);
		return fallback;
	}
}

interface NormalizeResult {
	url?: string;
	error?: string;
}

/**
 * Normalizes a URL by enforcing protocol, removing hash fragments, and stripping trailing slashes.
 */
export function normalizeUrl(url: string): NormalizeResult {
	if (!url || typeof url !== "string") {
		return { error: "URL is required" };
	}

	let normalizedUrl = url.trim();

	if (!/^https?:\/\//i.test(normalizedUrl)) {
		normalizedUrl = `http://${normalizedUrl}`;
	}

	try {
		const parsed = new URL(normalizedUrl);

		if (!["http:", "https:"].includes(parsed.protocol)) {
			return { error: "Only HTTP and HTTPS URLs are supported" };
		}

		parsed.hash = "";

		let result = parsed.toString();

		if (result.endsWith("/") && parsed.pathname !== "/") {
			result = result.slice(0, -1);
		}

		return { url: result };
	} catch {
		return { error: "Invalid URL format" };
	}
}

type CheerioLike = (selector: string) => {
	text(): string;
	each(callback: (index: number, element: unknown) => void): void;
	attr(name: string): string | undefined;
};

interface MetadataResult {
	title: string;
	description: string;
}

/** Extracts title and description metadata from a Cheerio-loaded HTML document. */
export function extractMetadata($: CheerioLike): MetadataResult {
	const title = $("title").text().trim() || "";

	let description = "";
	$('meta[name="description"]').each((_: number, el: unknown) => {
		description = $(el as string).attr("content") || "";
	});
	if (!description) {
		$('meta[property="og:description"]').each((_: number, el: unknown) => {
			description = $(el as string).attr("content") || "";
		});
	}

	return { title, description };
}

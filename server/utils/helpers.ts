import { config } from "../config/env.js";
import { REQUEST_CONSTANTS } from "../constants.js";
import type { DatabaseLike, LoggerLike } from "../types.js";
import { LRUCacheWithTTL } from "./lruCache.js";
import { secureFetch } from "./secureFetch.js";

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
const ROBOTS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface Rule {
	userAgent: string;
	allow: string[];
	disallow: string[];
	crawlDelay?: number;
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
		// $ matches end of string (must restore after escaping)
		const regexPattern = pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*/g, ".*")
			.replace(/\\\$/g, "$");

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

		// RFC 9309: longest matching pattern wins.
		// For equal-length matches, Allow takes precedence over Disallow.
		let longestAllow = -1;
		for (const allowPattern of rule.allow) {
			if (this.matchesRule(path, allowPattern)) {
				longestAllow = Math.max(longestAllow, allowPattern.length);
			}
		}

		let longestDisallow = -1;
		for (const disallowPattern of rule.disallow) {
			if (this.matchesRule(path, disallowPattern)) {
				longestDisallow = Math.max(longestDisallow, disallowPattern.length);
			}
		}

		// No matching rules means allowed
		if (longestAllow === -1 && longestDisallow === -1) return true;
		// Allow wins on equal length (per RFC 9309)
		return longestAllow >= longestDisallow;
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

const robotsCache = new LRUCacheWithTTL<string, RobotsResult>(
	ROBOTS_CACHE_MAX_SIZE,
	ROBOTS_CACHE_TTL_MS,
);

interface RobotsOptions {
	allowOnFailure?: boolean;
}

/**
 * Fetches and parses robots.txt for a domain with database persistence and TTL-based caching.
 *
 * Strategy:
 * 1. Check in-memory cache.
 * 2. Check database.
 * 3. Fetch from network (HTTPS first, fall back to HTTP).
 * 4. On failure, optionally allow all (default).
 */
export async function getRobotsRules(
	domain: string,
	db: DatabaseLike,
	logger: LoggerLike,
	{ allowOnFailure = true }: RobotsOptions = {},
): Promise<RobotsResult | null> {
	if (robotsCache.has(domain)) {
		return robotsCache.get(domain) ?? null;
	}

	try {
		const domainSettings = db
			.query("SELECT robots_txt FROM domain_settings WHERE domain = ?")
			.get(domain) as { robots_txt?: string } | undefined;

		if (domainSettings?.robots_txt) {
			const robots = new NativeRobotsParser(domainSettings.robots_txt);
			robotsCache.set(domain, robots);
			return robots;
		}

		// Try HTTPS first, fall back to HTTP to avoid wasteful parallel requests.
		// Most sites serve robots.txt over HTTPS; firing both simultaneously doubles
		// network usage for no practical benefit.
		let robotsTxt: string | null = null;

		for (const protocol of ["https", "http"] as const) {
			try {
				const response = await secureFetch({
					url: `${protocol}://${domain}/robots.txt`,
					signal: AbortSignal.timeout(
						REQUEST_CONSTANTS.ROBOTS_FETCH_TIMEOUT_MS,
					),
					headers: {
						"User-Agent": config.userAgent,
					},
					redirect: "follow",
				});

				if (response.ok) {
					robotsTxt = await response.text();
					break; // Got a good response — no need to try HTTP
				}
			} catch {
				// Protocol failed — continue to next
			}
		}

		if (!robotsTxt) {
			logger.warn(`Failed to download robots.txt for ${domain}`);
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
		const message = getErrorMessage(err);
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

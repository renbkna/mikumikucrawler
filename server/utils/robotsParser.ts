import type { Database } from "bun:sqlite";
import { config } from "../config/env.js";
import { MEMORY_CONSTANTS, REQUEST_CONSTANTS } from "../constants.js";
import { getDomainRobotsTxt, upsertDomainRobotsTxt } from "../data/queries.js";
import type { LoggerLike } from "../types.js";
import { getErrorMessage } from "./helpers.js";
import { LRUCacheWithTTL } from "./lruCache.js";
import { secureFetch } from "./secureFetch.js";

// --- NativeRobotsParser ---

interface Rule {
	userAgent: string;
	/** Pre-compiled allow patterns for O(1) matching without repeated RegExp construction. */
	allow: CompiledPattern[];
	/** Pre-compiled disallow patterns. */
	disallow: CompiledPattern[];
	crawlDelay?: number;
}

interface CompiledPattern {
	/** Original pattern string — used for length comparison (RFC 9309 longest-match). */
	raw: string;
	/** Compiled RegExp for efficient matching. */
	regex: RegExp;
}

export interface RobotsResult {
	isAllowed(url: string, userAgent?: string): boolean;
	isDisallowed(url: string, userAgent?: string): boolean;
	getCrawlDelay(userAgent?: string): number | undefined;
	getSitemaps(): string[];
}

/**
 * Robots.txt parser that pre-compiles all patterns at parse time.
 *
 * Pre-compilation means each pattern is turned into a RegExp once in
 * the constructor, rather than on every isAllowed() call. For a site with
 * 50 rules checked against 1000 URLs this cuts ~50 000 RegExp constructions
 * down to ~50.
 *
 * Implements RFC 9309 longest-match precedence with Allow > Disallow on ties.
 */
export class NativeRobotsParser implements RobotsResult {
	private rules: Rule[] = [];
	private sitemaps: string[] = [];

	constructor(robotsTxt: string) {
		this.parse(robotsTxt);
	}

	/**
	 * Converts a robots.txt wildcard pattern to a pre-compiled RegExp.
	 * Special characters are escaped first, then `*` → `.*` and trailing `$` is
	 * treated as an end-of-string anchor (per the spec).
	 */
	private static compilePattern(pattern: string): RegExp | null {
		// Escape all regex meta-characters except * and $
		// Note: $ is intentionally excluded from escaping — it is a valid end-of-string
		// anchor in robots.txt patterns (RFC 9309 §2.2.3) and maps directly to the regex
		// `$` anchor without any transformation.
		const escaped = pattern.replace(/[.+^{}()|[\]\\]/g, "\\$&");
		// * → match any sequence of characters (robots.txt wildcard)
		// Prefix with ^ so patterns match from the start of the path (RFC 9309 §2.2.2).
		// Without the anchor, a pattern like `/private` would incorrectly match
		// `/other/private/path` anywhere in the string.
		const regexSource = `^${escaped.replace(/\*/g, ".*")}`;

		try {
			return new RegExp(regexSource);
		} catch {
			return null; // Fallback: caller uses raw startsWith
		}
	}

	private parse(robotsTxt: string): void {
		const lines = robotsTxt.split("\n");
		let currentRule:
			| (Omit<Rule, "allow" | "disallow"> & {
					allow: string[];
					disallow: string[];
			  })
			| null = null;

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
						this.rules.push(this.compileRule(currentRule));
					}
					currentRule = {
						userAgent: value.toLowerCase(),
						allow: [],
						disallow: [],
					};
					break;
				case "allow":
					if (currentRule) currentRule.allow.push(value);
					break;
				case "disallow":
					if (currentRule) currentRule.disallow.push(value);
					break;
				case "crawl-delay":
					if (currentRule) currentRule.crawlDelay = Number.parseFloat(value);
					break;
				case "sitemap":
					this.sitemaps.push(value);
					break;
			}
		}

		if (currentRule) {
			this.rules.push(this.compileRule(currentRule));
		}
	}

	/** Converts string pattern lists to pre-compiled CompiledPattern arrays. */
	private compileRule(raw: {
		userAgent: string;
		allow: string[];
		disallow: string[];
		crawlDelay?: number;
	}): Rule {
		const compile = (patterns: string[]): CompiledPattern[] =>
			patterns.map((p) => ({
				raw: p,
				regex: NativeRobotsParser.compilePattern(p) ?? /(?!)/,
			}));

		return {
			userAgent: raw.userAgent,
			allow: compile(raw.allow),
			disallow: compile(raw.disallow),
			crawlDelay: raw.crawlDelay,
		};
	}

	private getPathFromUrl(url: string): string {
		try {
			return new URL(url).pathname;
		} catch {
			return url.startsWith("/") ? url : `/${url}`;
		}
	}

	private findMatchingRule(userAgent?: string): Rule | null {
		if (!userAgent) {
			return this.rules.find((r) => r.userAgent === "*") ?? null;
		}

		const ua = userAgent.toLowerCase();
		return (
			this.rules.find((r) => r.userAgent === ua) ??
			this.rules.find((r) => ua.includes(r.userAgent)) ??
			this.rules.find((r) => r.userAgent === "*") ??
			null
		);
	}

	isAllowed(url: string, userAgent?: string): boolean {
		const path = this.getPathFromUrl(url);
		const rule = this.findMatchingRule(userAgent);
		if (!rule) return true;

		// RFC 9309: longest matching pattern wins; Allow beats Disallow on ties.
		let longestAllow = -1;
		for (const { raw, regex } of rule.allow) {
			if (regex.test(path)) {
				longestAllow = Math.max(longestAllow, raw.length);
			}
		}

		let longestDisallow = -1;
		for (const { raw, regex } of rule.disallow) {
			if (regex.test(path)) {
				longestDisallow = Math.max(longestDisallow, raw.length);
			}
		}

		if (longestAllow === -1 && longestDisallow === -1) return true;
		return longestAllow >= longestDisallow;
	}

	isDisallowed(url: string, userAgent?: string): boolean {
		return !this.isAllowed(url, userAgent);
	}

	getCrawlDelay(userAgent?: string): number | undefined {
		return this.findMatchingRule(userAgent)?.crawlDelay;
	}

	getSitemaps(): string[] {
		return [...this.sitemaps];
	}
}

// --- Robots cache + fetch logic ---

const robotsCache = new LRUCacheWithTTL<string, RobotsResult>(
	MEMORY_CONSTANTS.ROBOTS_CACHE_MAX_SIZE,
	MEMORY_CONSTANTS.ROBOTS_CACHE_TTL_MS,
);

interface RobotsOptions {
	allowOnFailure?: boolean;
}

/**
 * Fetches and parses robots.txt for a domain with database persistence and TTL-based caching.
 *
 * Strategy:
 * 1. Check in-memory LRU cache.
 * 2. Check database.
 * 3. Fetch from network (HTTPS first, fall back to HTTP).
 * 4. On failure, optionally allow all (default).
 */
export async function getRobotsRules(
	domain: string,
	db: Database,
	logger: LoggerLike,
	{ allowOnFailure = true }: RobotsOptions = {},
): Promise<RobotsResult | null> {
	if (robotsCache.has(domain)) {
		return robotsCache.get(domain) ?? null;
	}

	try {
		const cachedRobotsTxt = getDomainRobotsTxt(db, domain);

		if (cachedRobotsTxt) {
			const robots = new NativeRobotsParser(cachedRobotsTxt);
			robotsCache.set(domain, robots);
			return robots;
		}

		// Try HTTPS first, fall back to HTTP.
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
					headers: { "User-Agent": config.userAgent },
					redirect: "follow",
				});

				if (response.ok) {
					robotsTxt = await response.text();
					break;
				}
			} catch {
				// Protocol failed — continue to next
			}
		}

		if (!robotsTxt) {
			logger.warn(`Failed to download robots.txt for ${domain}`);
			if (!allowOnFailure) return null;
			const fallback = new NativeRobotsParser("");
			robotsCache.set(domain, fallback);
			return fallback;
		}

		const robots = new NativeRobotsParser(robotsTxt);

		upsertDomainRobotsTxt(db, domain, robotsTxt);

		robotsCache.set(domain, robots);
		return robots;
	} catch (err) {
		const message = getErrorMessage(err);
		logger.warn(`Failed to get robots.txt for ${domain}: ${message}`);
		if (!allowOnFailure) return null;
		const fallback = new NativeRobotsParser("");
		robotsCache.set(domain, fallback);
		return fallback;
	}
}

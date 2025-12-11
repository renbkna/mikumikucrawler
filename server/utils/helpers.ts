import axios from "axios";
import type Database from "better-sqlite3";
// Import robots-parser - types declared in server/types/modules.d.ts
import robotsParser from "robots-parser";
import type { Logger } from "winston";

// Configure Puppeteer - Fix for rendering environments like Render.com
const isProd = process.env.NODE_ENV === "production";

// Robots.txt cache with TTL and size limit
const ROBOTS_CACHE_MAX_SIZE = 100;
const ROBOTS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

// Use the interface from our module declaration
interface RobotsResult {
	isAllowed(url: string, userAgent?: string): boolean;
	isDisallowed(url: string, userAgent?: string): boolean;
	getCrawlDelay(userAgent?: string): number | undefined;
	getSitemaps(): string[];
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

		// Check if expired
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
		// Evict oldest entries if at capacity
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

// Helper function to get robots.txt rules
export async function getRobotsRules(
	domain: string,
	dbPromise: Promise<Database.Database>,
	logger: Logger,
	{ allowOnFailure = true }: RobotsOptions = {},
): Promise<RobotsResult | null> {
	if (robotsCache.has(domain)) {
		return robotsCache.get(domain) ?? null;
	}

	try {
		const db = await dbPromise;
		const domainSettings = db
			.prepare("SELECT robots_txt FROM domain_settings WHERE domain = ?")
			.get(domain) as { robots_txt?: string } | undefined;

		if (domainSettings?.robots_txt) {
			const robots = robotsParser(
				`http://${domain}/robots.txt`,
				domainSettings.robots_txt,
			);
			robotsCache.set(domain, robots);
			return robots;
		}

		const protocols = ["https", "http"];
		let robotsTxt: string | null = null;
		let successfulProtocol: string | null = null;
		let lastError: Error | null = null;

		for (const protocol of protocols) {
			try {
				const response = await axios.get(`${protocol}://${domain}/robots.txt`, {
					timeout: 5000,
					maxRedirects: 3,
				});
				robotsTxt = response.data;
				successfulProtocol = protocol;
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
			const fallback = robotsParser(`http://${domain}/robots.txt`, "");
			robotsCache.set(domain, fallback);
			return fallback;
		}

		const robotsUrl = `${successfulProtocol || "http"}://${domain}/robots.txt`;
		const robots = robotsParser(robotsUrl, robotsTxt);

		db.prepare(
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
		const fallback = robotsParser(`http://${domain}/robots.txt`, "");
		robotsCache.set(domain, fallback);
		return fallback;
	}
}

interface NormalizeResult {
	url?: string;
	error?: string;
}

/**
 * Normalize a URL for consistent handling across the codebase.
 * - Adds http:// protocol if missing
 * - Removes trailing slashes
 * - Removes hash fragments
 */
export function normalizeUrl(url: string): NormalizeResult {
	if (!url || typeof url !== "string") {
		return { error: "URL is required" };
	}

	let normalizedUrl = url.trim();

	// Add protocol if missing
	if (!/^https?:\/\//i.test(normalizedUrl)) {
		normalizedUrl = `http://${normalizedUrl}`;
	}

	try {
		const parsed = new URL(normalizedUrl);

		// Only allow http and https protocols
		if (!["http:", "https:"].includes(parsed.protocol)) {
			return { error: "Only HTTP and HTTPS URLs are supported" };
		}

		// Remove hash fragment
		parsed.hash = "";

		// Get the normalized URL
		let result = parsed.toString();

		// Remove trailing slash (except for root path)
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

// Helper function to extract metadata from HTML
export function extractMetadata($: CheerioLike): MetadataResult {
	const title = $("title").text().trim() || "";

	// Extract description from meta tags
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

// Enhanced Chrome path detection for different environments
export const getChromePaths = async (): Promise<string[]> => {
	const basePaths: string[] = [];

	// Try to get Puppeteer's bundled Chrome first (most reliable)
	try {
		const puppeteer = await import("puppeteer");
		const puppeteerPath =
			(puppeteer.default?.executablePath?.() as string | undefined) ||
			(
				puppeteer as unknown as { executablePath?: () => string }
			).executablePath?.();
		if (puppeteerPath) {
			basePaths.push(puppeteerPath);
		}
	} catch {
		// Puppeteer not available or executablePath failed, continue with fallbacks
	}

	// Custom environment variable (highest priority after Puppeteer)
	if (process.env.PUPPETEER_EXECUTABLE_PATH) {
		basePaths.push(process.env.PUPPETEER_EXECUTABLE_PATH);
	}
	if (process.env.CHROME_BIN) {
		basePaths.push(process.env.CHROME_BIN);
	}

	if (isProd) {
		// Production paths (cloud hosting and Docker)
		basePaths.push(
			// Docker containers (Google Chrome Stable)
			"/usr/bin/google-chrome-stable",
			"/usr/bin/google-chrome",
			"/usr/bin/chromium-browser",
			"/usr/bin/chromium",
			// Additional Docker paths
			"/opt/google/chrome/chrome",
			"/opt/google/chrome/google-chrome",
		);
	} else {
		// Development paths - system Chrome installations
		basePaths.push(
			// Windows
			"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
			"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
			// Linux
			"/usr/bin/google-chrome",
			"/usr/bin/chromium-browser",
			// macOS
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		);
	}

	return basePaths.filter(Boolean); // Remove undefined/null paths
};

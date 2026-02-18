/**
 * Shared utility helpers.
 *
 * Robots.txt parsing logic has been moved to ./robotsParser.ts.
 * Re-exported here so existing consumers don't need to change their imports.
 */

// Re-export so callers importing getRobotsRules from helpers.js continue to work.
export { getRobotsRules } from "./robotsParser.js";

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

interface NormalizeResult {
	url?: string;
	error?: string;
}

/**
 * Query parameters that carry no semantic page identity — they are purely for
 * tracking, analytics, or session state and should be stripped before storing
 * or comparing URLs so that the same page reached via different campaigns is
 * not crawled multiple times.
 *
 * Sources: UTM (Google Analytics), fbclid (Facebook), gclid/msclkid (Google/
 * Microsoft Ads), ttclid (TikTok), twclid (Twitter/X), _ga/_gid (GA cookies),
 * and common server-side session ID parameter names.
 */
const STRIP_PARAMS = new Set([
	// UTM campaign parameters
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_term",
	"utm_content",
	"utm_id",
	// Ad-network click IDs
	"fbclid",
	"gclid",
	"gbraid",
	"wbraid",
	"msclkid",
	"ttclid",
	"twclid",
	"li_fat_id",
	// Google Analytics client/session IDs (sometimes leaked into URLs)
	"_ga",
	"_gid",
	// Common server-side session ID names
	"sessionid",
	"phpsessid",
	"jsessionid",
	"aspsessionid",
	"sid",
]);

/**
 * Normalizes a URL to a canonical form so that semantically identical URLs
 * produce an identical string, preventing duplicate crawls.
 *
 * Transformations applied (in order):
 * 1. Enforce protocol prefix (defaults to http://).
 * 2. Reject non-HTTP/HTTPS protocols.
 * 3. Lowercase the hostname (domain names are case-insensitive per RFC 3986).
 * 4. Strip default ports (80 for http, 443 for https).
 * 5. Remove the fragment/hash (server never sees it; irrelevant for crawling).
 * 6. Strip known tracking / session parameters (utm_*, fbclid, sessionid, …).
 * 7. Sort remaining query parameters alphabetically so `?b=2&a=1` ≡ `?a=1&b=2`.
 * 8. Strip trailing slash from non-root paths.
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

		// 3. Case-normalise hostname only — paths are case-sensitive on most servers
		parsed.hostname = parsed.hostname.toLowerCase();

		// 4. Strip default ports so http://example.com:80/ ≡ http://example.com/
		if (
			(parsed.protocol === "http:" && parsed.port === "80") ||
			(parsed.protocol === "https:" && parsed.port === "443")
		) {
			parsed.port = "";
		}

		// 5. Remove fragment — the server never receives it
		parsed.hash = "";

		// 6 + 7. Strip tracking/session params, then sort the remainder.
		if (parsed.search) {
			const params = new URLSearchParams(parsed.search);
			for (const key of [...params.keys()]) {
				if (STRIP_PARAMS.has(key.toLowerCase())) {
					params.delete(key);
				}
			}
			const sorted = new URLSearchParams([...params.entries()].sort());
			parsed.search = sorted.toString() ? `?${sorted.toString()}` : "";
		}

		// 8. Strip trailing slash from non-root paths
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

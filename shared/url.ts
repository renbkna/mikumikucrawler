import { isPrivateOrReservedIpAddressLiteral } from "./ipPolicy.js";

/**
 * URL normalization contract:
 * - input: user-entered or discovered URL text
 * - output: normalized HTTP(S) URL string or an explicit error
 * - shared invariants: lowercase hostname, no fragment, default ports removed,
 *   conservative path preservation
 * - canonical mode: tracking/session params stripped, query params sorted,
 *   terminal slash trimmed except for root path
 * - robots-match mode: query params and query ordering preserved for robots rule
 *   matching while still sharing parse/scheme/host/default-port invariants
 * - forbidden states: non-HTTP(S) schemes and unparsable URLs
 */
export type NormalizedUrlResult = { url: string } | { error: string };

const STRIP_PARAMS = new Set([
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_term",
	"utm_content",
	"utm_id",
	"fbclid",
	"gclid",
	"gbraid",
	"wbraid",
	"msclkid",
	"ttclid",
	"twclid",
	"li_fat_id",
	"_ga",
	"_gid",
	"sessionid",
	"phpsessid",
	"jsessionid",
	"aspsessionid",
	"sid",
]);

export function validatePublicHttpUrl(url: string): NormalizedUrlResult {
	const normalized = normalizeCanonicalHttpUrl(url);
	if ("error" in normalized) {
		return normalized;
	}

	const hostname = new URL(normalized.url).hostname;
	if (hostname.toLowerCase() === "localhost") {
		return { error: "Localhost targets are not allowed" };
	}

	if (isPrivateOrReservedIpAddressLiteral(hostname)) {
		return { error: "Private or reserved IP addresses are not allowed" };
	}

	return normalized;
}

function parseHttpUrl(url: string): URL | { error: string } {
	if (!url || typeof url !== "string") {
		return { error: "URL is required" };
	}

	let candidate = url.trim();
	const hasExplicitHttpScheme = /^https?:\/\//i.test(candidate);
	const hasSchemeLikePrefix = /^[a-z][a-z0-9+.-]*:/i.test(candidate);
	const looksLikeHostWithPort = /^[^/?#]+:\d/.test(candidate);

	if (hasSchemeLikePrefix && !hasExplicitHttpScheme && !looksLikeHostWithPort) {
		return { error: "Only HTTP and HTTPS URLs are supported" };
	}

	if (!hasExplicitHttpScheme) {
		candidate = `http://${candidate}`;
	}

	try {
		const parsed = new URL(candidate);

		if (!["http:", "https:"].includes(parsed.protocol)) {
			return { error: "Only HTTP and HTTPS URLs are supported" };
		}

		parsed.hostname = parsed.hostname.toLowerCase();

		if (
			(parsed.protocol === "http:" && parsed.port === "80") ||
			(parsed.protocol === "https:" && parsed.port === "443")
		) {
			parsed.port = "";
		}

		parsed.hash = "";
		return parsed;
	} catch {
		return { error: "Invalid URL format" };
	}
}

export function normalizeCanonicalHttpUrl(url: string): NormalizedUrlResult {
	const parsed = parseHttpUrl(url);
	if ("error" in parsed) {
		return parsed;
	}

	if (parsed.search) {
		const params = new URLSearchParams(parsed.search);
		for (const key of Array.from(params.keys())) {
			if (STRIP_PARAMS.has(key.toLowerCase())) {
				params.delete(key);
			}
		}
		const sorted = new URLSearchParams(
			[...params.entries()].toSorted(([left], [right]) =>
				left.localeCompare(right),
			),
		);
		parsed.search = sorted.toString() ? `?${sorted.toString()}` : "";
	}

	let result = parsed.toString();
	if (result.endsWith("/") && parsed.pathname !== "/") {
		result = result.slice(0, -1);
	}

	return { url: result };
}

export function normalizeRobotsMatchHttpUrl(url: string): NormalizedUrlResult {
	const parsed = parseHttpUrl(url);
	if ("error" in parsed) {
		return parsed;
	}

	return { url: parsed.toString() };
}

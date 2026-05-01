import ipaddr from "ipaddr.js";

/**
 * URL normalization contract:
 * - input: user-entered or discovered URL text
 * - output: canonical HTTP(S) URL string or an explicit error
 * - invariants: lowercase hostname, no fragment, default ports removed,
 *   tracking/session params stripped, query params sorted, conservative path
 *   preservation apart from terminal slash trimming
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

const ALLOWED_IP_RANGES = new Set(["unicast", "global"]);

function isPrivateOrReservedAddressLiteral(hostname: string): boolean {
	const normalizedHost =
		hostname.startsWith("[") && hostname.endsWith("]")
			? hostname.slice(1, -1)
			: hostname;
	try {
		let parsed: ipaddr.IPv4 | ipaddr.IPv6 = ipaddr.parse(normalizedHost);
		if (
			parsed.kind() === "ipv6" &&
			(parsed as ipaddr.IPv6).isIPv4MappedAddress()
		) {
			parsed = (parsed as ipaddr.IPv6).toIPv4Address();
		}
		return !ALLOWED_IP_RANGES.has(parsed.range());
	} catch {
		return false;
	}
}

export function validatePublicHttpUrl(url: string): NormalizedUrlResult {
	const normalized = normalizeHttpUrl(url);
	if ("error" in normalized) {
		return normalized;
	}

	const hostname = new URL(normalized.url).hostname;
	if (hostname.toLowerCase() === "localhost") {
		return { error: "Localhost targets are not allowed" };
	}

	if (isPrivateOrReservedAddressLiteral(hostname)) {
		return { error: "Private or reserved IP addresses are not allowed" };
	}

	return normalized;
}

export function normalizeHttpUrl(url: string): NormalizedUrlResult {
	if (!url || typeof url !== "string") {
		return { error: "URL is required" };
	}

	let normalizedUrl = url.trim();
	const hasExplicitHttpScheme = /^https?:\/\//i.test(normalizedUrl);
	const hasSchemeLikePrefix = /^[a-z][a-z0-9+.-]*:/i.test(normalizedUrl);
	const looksLikeHostWithPort = /^[^/?#]+:\d/.test(normalizedUrl);

	if (hasSchemeLikePrefix && !hasExplicitHttpScheme && !looksLikeHostWithPort) {
		return { error: "Only HTTP and HTTPS URLs are supported" };
	}

	if (!hasExplicitHttpScheme) {
		normalizedUrl = `http://${normalizedUrl}`;
	}

	try {
		const parsed = new URL(normalizedUrl);

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

		if (parsed.search) {
			const params = new URLSearchParams(parsed.search);
			for (const key of [...params.keys()]) {
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
	} catch {
		return { error: "Invalid URL format" };
	}
}

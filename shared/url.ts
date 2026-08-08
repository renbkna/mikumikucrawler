import { isPrivateOrReservedIpAddressLiteral } from "./ipPolicy.js";

/**
 * URL normalization contract:
 * - input: user-entered or discovered URL text
 * - output: normalized HTTP(S) URL string or an explicit error
 * - shared invariants: lowercase hostname, no fragment, default ports removed,
 *   one terminal DNS dot removed, and otherwise lossless path/query preservation
 * - canonical and robots-match modes share the same fetch-semantic URL. A
 *   crawler must not merge distinct resources by guessing which path or query
 *   components an origin considers significant.
 * - forbidden states: non-HTTP(S) schemes and unparsable URLs
 */
export type NormalizedUrlResult = { url: string } | { error: string };

export type ValidateUrlOptions = { allowLocalhost?: boolean };

/** Maximum untrusted URL text accepted before parsing or normalization. */
export const MAX_URL_LENGTH = 2000;

export function validatePublicHttpUrl(
	url: string,
	options: ValidateUrlOptions = {},
): NormalizedUrlResult {
	const normalized = normalizeCanonicalHttpUrl(url);
	if ("error" in normalized) {
		return normalized;
	}

	const hostname = new URL(normalized.url).hostname;
	if (!options.allowLocalhost && hostname.toLowerCase() === "localhost") {
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
	if (url.length > MAX_URL_LENGTH) {
		return { error: `URL exceeds maximum length of ${MAX_URL_LENGTH} characters` };
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
		parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");

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

	return { url: parsed.toString() };
}

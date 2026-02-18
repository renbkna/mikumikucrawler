import { resolveUrlSecurely } from "./secureFetch.js";

/**
 * Validates that a hostname resolves only to public IPs.
 * Prevents SSRF by ensuring no internal addresses are exposed.
 *
 * Delegates to resolveUrlSecurely so the DNS result is stored in the shared
 * LRU cache — avoiding a redundant uncached lookup before secureFetch does
 * its own resolution on the same hostname moments later.
 */
export async function assertPublicHostname(hostname: string): Promise<void> {
	if (!hostname) {
		throw new Error("Target host is not allowed");
	}

	// Construct a minimal URL so resolveUrlSecurely can parse the hostname
	// correctly (handles IPv6 bracket notation, localhost, etc.)
	// IPv6 addresses must be wrapped in brackets for URL construction.
	const needsBrackets =
		hostname.includes(":") &&
		!hostname.startsWith("[") &&
		!hostname.endsWith("]");
	const urlToCheck = needsBrackets
		? `http://[${hostname}]`
		: `http://${hostname}`;

	// resolveUrlSecurely validates against private/reserved ranges and caches
	// the DNS result. Any SSRF-unsafe hostname throws here.
	await resolveUrlSecurely(urlToCheck);
}

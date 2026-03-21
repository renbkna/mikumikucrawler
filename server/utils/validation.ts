import { CrawlerError, ErrorCode } from "../errors.js";
import { resolveUrlSecurely } from "./secureFetch.js";

/**
 * Validates that a hostname resolves only to public IPs.
 * Delegates to resolveUrlSecurely so the DNS result is cached.
 * Throws CrawlerError with SSRF_* codes on failure.
 */
export async function assertPublicHostname(hostname: string): Promise<void> {
	if (!hostname) {
		throw new CrawlerError(ErrorCode.SSRF_EMPTY_HOST, "Target host is empty");
	}

	const needsBrackets =
		hostname.includes(":") &&
		!hostname.startsWith("[") &&
		!hostname.endsWith("]");
	const urlToCheck = needsBrackets
		? `http://[${hostname}]`
		: `http://${hostname}`;

	await resolveUrlSecurely(urlToCheck);
}

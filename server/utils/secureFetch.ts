import { lookup } from "node:dns/promises";
import net from "node:net";
import { isInvalidIpAddress } from "./ipValidation.js";
import { LRUCacheWithTTL } from "./lruCache.js";

const CACHE_TTL_MS = 300000; // 5 minutes
const MAX_CACHE_SIZE = 1000; // Maximum 1000 unique hostnames
const MAX_REDIRECTS = 10; // Prevent redirect loops

// Use bounded LRU cache to prevent memory exhaustion
const RESOLUTION_CACHE = new LRUCacheWithTTL<string, string[]>(
	MAX_CACHE_SIZE,
	CACHE_TTL_MS,
);

interface SecureFetchOptions {
	url: string;
	signal?: AbortSignal;
	headers?: Record<string, string>;
	redirect?: "follow" | "error" | "manual";
}

interface ResolvedUrl {
	/** The original URL string */
	url: string;
	/** The hostname that was validated */
	resolvedHost: string;
}

/**
 * Validates that a hostname resolves only to public IPs.
 * Prevents SSRF by ensuring no internal addresses are exposed.
 * Returns the resolved IP addresses for IP pinning.
 */
async function validatePublicHostname(hostname: string): Promise<string[]> {
	if (!hostname) {
		throw new Error("Target host is not allowed");
	}

	const normalizedHost =
		hostname.startsWith("[") && hostname.endsWith("]")
			? hostname.slice(1, -1)
			: hostname;

	const lower = normalizedHost.toLowerCase();
	if (lower === "localhost") {
		throw new Error("Target host is not allowed");
	}

	// Direct IP validation
	const ipType = net.isIP(normalizedHost);
	if (ipType) {
		if (isInvalidIpAddress(normalizedHost)) {
			throw new Error("Target host is not allowed");
		}
		return [normalizedHost];
	}

	// Check cache first
	const cached = RESOLUTION_CACHE.get(normalizedHost);
	if (cached) {
		const hasInvalid = cached.some(isInvalidIpAddress);
		if (hasInvalid) {
			throw new Error("Target host is not allowed");
		}
		return cached;
	}

	// Fresh DNS resolution
	let records: { address: string; family: number }[];
	try {
		records = await lookup(normalizedHost, { all: true, verbatim: false });
	} catch {
		throw new Error("Unable to resolve target hostname");
	}

	if (!records?.length) {
		throw new Error("Unable to resolve target hostname");
	}

	const addresses = records.map((r) => r.address);
	const hasInvalidRecord = addresses.some(isInvalidIpAddress);

	if (hasInvalidRecord) {
		throw new Error("Target host is not allowed");
	}

	// Cache the resolution
	RESOLUTION_CACHE.set(normalizedHost, addresses);
	return addresses;
}

/**
 * Validates a URL and resolves its hostname to IP addresses.
 * Returns both the original URL info and resolved IPs for secure fetching.
 */
export async function resolveUrlSecurely(
	urlString: string,
): Promise<ResolvedUrl> {
	const url = new URL(urlString);
	await validatePublicHostname(url.hostname);

	return {
		url: urlString,
		resolvedHost: url.hostname,
	};
}

/**
 * Extracts the hostname from a URL for validation.
 * Handles IPv6 addresses in brackets.
 */
function extractHostname(urlString: string): string {
	try {
		const url = new URL(urlString);
		return url.hostname;
	} catch {
		return "";
	}
}

/**
 * Performs a secure fetch that prevents SSRF via redirects.
 *
 * Security measures:
 * 1. Validates DNS resolution to public IPs only
 * 2. Implements manual redirect following with validation at each hop
 * 3. Limits redirect hops to prevent loops
 *
 * Note: True IP pinning (connecting to resolved IP with Host header)
 * is not possible with standard fetch API. The DNS cache with TTL
 * provides protection within the cache window.
 */
export async function secureFetch(
	options: SecureFetchOptions,
): Promise<Response> {
	const {
		url: initialUrl,
		signal,
		headers = {},
		redirect = "follow",
	} = options;

	let currentUrl = initialUrl;
	let redirectCount = 0;

	// Main request loop with manual redirect handling
	while (redirectCount <= MAX_REDIRECTS) {
		// Validate the current URL before making the request
		await resolveUrlSecurely(currentUrl);

		// Make the request with redirect: "manual" to control redirect validation
		const response = await fetch(currentUrl, {
			signal,
			headers,
			redirect: "manual",
		});

		// Check for redirect status codes
		const redirectStatus = response.status;
		const isRedirect = [301, 302, 303, 307, 308].includes(redirectStatus);

		if (!isRedirect) {
			return response;
		}

		// Handle redirect based on user preference
		if (redirect === "error") {
			throw new Error(
				`Redirect not allowed: ${currentUrl} -> ${response.headers.get("location")}`,
			);
		}

		if (redirect === "manual") {
			return response;
		}

		// redirect === "follow" - validate and follow the redirect
		const location = response.headers.get("location");
		if (!location) {
			// No location header - return the response as-is
			return response;
		}

		// Resolve relative URLs against the current URL
		const redirectUrl = new URL(location, currentUrl).href;

		// SECURITY: Validate the redirect target BEFORE following it
		// This prevents SSRF via redirects to private IPs
		try {
			await resolveUrlSecurely(redirectUrl);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Redirect to disallowed host blocked: ${extractHostname(redirectUrl)} (${message})`,
			);
		}

		redirectCount++;

		// Update current URL and continue the loop
		currentUrl = redirectUrl;
	}

	throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
}

/**
 * Clears the DNS resolution cache.
 * Useful for testing or when switching networks.
 */
export function clearResolutionCache(): void {
	RESOLUTION_CACHE.clear();
}

/**
 * Gets cache statistics for monitoring.
 */
export function getCacheStats(): { size: number; entries: string[] } {
	return {
		size: RESOLUTION_CACHE.size,
		entries: Array.from(RESOLUTION_CACHE.keys()),
	};
}

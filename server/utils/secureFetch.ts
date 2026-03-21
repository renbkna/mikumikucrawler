import { lookup } from "node:dns/promises";
import net from "node:net";
import { URL } from "node:url";
import { CrawlerError, ErrorCode } from "../errors.js";
import { isInvalidIpAddress } from "./ipValidation.js";
import { LRUCacheWithTTL } from "./lruCache.js";

const CACHE_TTL_MS = 300000; // 5 minutes
const MAX_CACHE_SIZE = 1000; // Maximum 1000 unique hostnames

const RESOLUTION_CACHE = new LRUCacheWithTTL<string, string[]>(
	MAX_CACHE_SIZE,
	CACHE_TTL_MS,
);

interface SecureFetchOptions {
	url: string;
	signal?: AbortSignal;
	headers?: Record<string, string>;
	redirect?: "follow" | "error" | "manual";
	/** Injectable fetch for testing. Defaults to globalThis.fetch. */
	fetchFn?: typeof fetch;
}

interface ResolvedHost {
	/** The first validated public IP address. */
	ip: string;
	/** The original hostname for Host header / TLS SNI. */
	hostname: string;
}

/**
 * Validates that a hostname resolves only to public IPs.
 * Returns the validated IP addresses for direct connection.
 */
async function validateAndResolve(hostname: string): Promise<string[]> {
	if (!hostname) {
		throw new CrawlerError(ErrorCode.SSRF_EMPTY_HOST, "Target host is empty");
	}

	const normalizedHost =
		hostname.startsWith("[") && hostname.endsWith("]")
			? hostname.slice(1, -1)
			: hostname;

	const lower = normalizedHost.toLowerCase();
	if (lower === "localhost") {
		throw new CrawlerError(
			ErrorCode.SSRF_LOCALHOST,
			"Localhost targets are not allowed",
		);
	}

	// Direct IP — validate and return as-is
	const ipType = net.isIP(normalizedHost);
	if (ipType) {
		if (isInvalidIpAddress(normalizedHost)) {
			throw new CrawlerError(
				ErrorCode.SSRF_PRIVATE_IP,
				`Private/reserved IP address: ${normalizedHost}`,
			);
		}
		return [normalizedHost];
	}

	// Check cache
	const cached = RESOLUTION_CACHE.get(normalizedHost);
	if (cached) {
		const hasInvalid = cached.some(isInvalidIpAddress);
		if (hasInvalid) {
			throw new CrawlerError(
				ErrorCode.SSRF_RESOLVED_PRIVATE,
				`Hostname ${normalizedHost} resolves to a private/reserved IP`,
			);
		}
		return cached;
	}

	// Fresh DNS resolution
	let records: { address: string; family: number }[];
	try {
		records = await lookup(normalizedHost, { all: true, verbatim: false });
	} catch (cause) {
		throw new CrawlerError(
			ErrorCode.SSRF_DNS_FAILURE,
			`DNS resolution failed for ${normalizedHost}`,
			{ cause },
		);
	}

	if (!records?.length) {
		throw new CrawlerError(
			ErrorCode.SSRF_DNS_FAILURE,
			`No DNS records for ${normalizedHost}`,
		);
	}

	const addresses = records.map((r) => r.address);
	const hasInvalidRecord = addresses.some(isInvalidIpAddress);

	if (hasInvalidRecord) {
		throw new CrawlerError(
			ErrorCode.SSRF_RESOLVED_PRIVATE,
			`Hostname ${normalizedHost} resolves to a private/reserved IP`,
		);
	}

	RESOLUTION_CACHE.set(normalizedHost, addresses);
	return addresses;
}

/**
 * Resolves a URL's hostname to validated public IPs.
 * Returns the IP and original hostname for IP-pinned fetch.
 */
export async function resolveUrlSecurely(
	urlString: string,
): Promise<ResolvedHost> {
	const url = new URL(urlString);
	const addresses = await validateAndResolve(url.hostname);

	return {
		ip: addresses[0],
		hostname: url.hostname,
	};
}

/**
 * Performs an IP-pinned fetch that eliminates DNS rebinding attacks.
 *
 * After validating the hostname resolves to public IPs, we connect directly
 * to the validated IP. The original hostname is preserved in the Host header
 * and TLS SNI so certificates validate correctly.
 */
export async function secureFetch(
	options: SecureFetchOptions,
): Promise<Response> {
	const {
		url,
		signal,
		headers,
		redirect = "follow",
		fetchFn = globalThis.fetch,
	} = options;

	const resolved = await resolveUrlSecurely(url);
	const parsedUrl = new URL(url);

	// Build IP-pinned URL: replace hostname with validated IP
	const pinnedUrl = new URL(url);
	const isIPv6 = resolved.ip.includes(":");
	pinnedUrl.hostname = isIPv6 ? `[${resolved.ip}]` : resolved.ip;

	// Preserve original hostname in Host header for virtual hosting + TLS SNI
	const pinnedHeaders: Record<string, string> = {
		...headers,
		Host: parsedUrl.port
			? `${resolved.hostname}:${parsedUrl.port}`
			: resolved.hostname,
	};

	const fetchOptions: RequestInit & { tls?: { serverName?: string } } = {
		signal,
		headers: pinnedHeaders,
		redirect,
	};

	// For HTTPS: set TLS server name so certificate validation uses the
	// original hostname, not the IP address we're connecting to.
	if (parsedUrl.protocol === "https:") {
		fetchOptions.tls = { serverName: resolved.hostname };
	}

	return fetchFn(pinnedUrl.toString(), fetchOptions);
}

export function clearResolutionCache(): void {
	RESOLUTION_CACHE.clear();
}

export function getCacheStats(): { size: number; entries: string[] } {
	return {
		size: RESOLUTION_CACHE.size,
		entries: Array.from(RESOLUTION_CACHE.keys()),
	};
}

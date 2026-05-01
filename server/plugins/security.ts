import { lookup } from "node:dns/promises";
import net from "node:net";
import { Elysia } from "elysia";
import { isInvalidIpAddress } from "../utils/ipValidation.js";
import { LRUCacheWithTTL } from "../utils/lruCache.js";

const RESOLUTION_TTL_MS = 5 * 60 * 1000;
const RESOLUTION_CACHE_MAX_ENTRIES = 512;
const MAX_REDIRECT_HOPS = 10;
const REDIRECT_TO_GET_STATUSES = new Set([301, 302, 303]);
const ORIGIN_BOUND_HEADERS = new Set([
	"authorization",
	"cookie",
	"host",
	"proxy-authorization",
]);
const BODY_HEADERS = new Set(["content-length", "content-type"]);

export interface Resolver {
	resolveHost(hostname: string): Promise<string[]>;
	assertPublicHostname(hostname: string): Promise<void>;
}

export interface HttpClientRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: BodyInit;
	signal?: AbortSignal;
	redirect?: RequestRedirect;
}

export interface HttpClient {
	fetch(request: HttpClientRequest): Promise<Response>;
}

export class DefaultResolver implements Resolver {
	private readonly cache = new LRUCacheWithTTL<string, string[]>(
		RESOLUTION_CACHE_MAX_ENTRIES,
		RESOLUTION_TTL_MS,
	);

	constructor(private readonly lookupFn: typeof lookup = lookup) {}

	async assertPublicHostname(hostname: string): Promise<void> {
		await this.resolveHost(hostname);
	}

	async resolveHost(hostname: string): Promise<string[]> {
		if (!hostname) {
			throw new Error("Target host is empty");
		}

		const normalizedHost =
			hostname.startsWith("[") && hostname.endsWith("]")
				? hostname.slice(1, -1)
				: hostname;

		if (normalizedHost.toLowerCase() === "localhost") {
			throw new Error("Localhost targets are not allowed");
		}

		const ipType = net.isIP(normalizedHost);
		if (ipType > 0) {
			if (isInvalidIpAddress(normalizedHost)) {
				throw new Error(`Private or reserved IP address: ${normalizedHost}`);
			}

			return [normalizedHost];
		}

		const cached = this.cache.get(normalizedHost);
		if (cached) {
			return cached;
		}

		const records = await this.lookupFn(normalizedHost, {
			all: true,
			verbatim: false,
		});
		const addresses = records.map((record) => record.address);

		if (addresses.length === 0) {
			throw new Error(`No DNS records for ${normalizedHost}`);
		}

		if (addresses.some((address) => isInvalidIpAddress(address))) {
			throw new Error(
				`Hostname ${normalizedHost} resolves to a private or reserved IP`,
			);
		}

		this.cache.set(normalizedHost, addresses);

		return addresses;
	}
}

export class PinnedHttpClient implements HttpClient {
	constructor(
		private readonly resolver: Resolver,
		private readonly fetchFn: typeof fetch = globalThis.fetch,
	) {}

	async fetch(request: HttpClientRequest): Promise<Response> {
		const seenUrls = new Set<string>();
		let currentUrl = request.url;
		let redirectCount = 0;
		let method = request.method?.toUpperCase() ?? "GET";
		let body = request.body;
		let headers = sanitizeRequestHeaders(request.headers ?? {});

		for (;;) {
			if (seenUrls.has(currentUrl)) {
				throw new Error(`Redirect loop detected for ${currentUrl}`);
			}
			seenUrls.add(currentUrl);

			const url = new URL(currentUrl);
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				throw new Error(`Disallowed protocol: ${url.protocol}`);
			}
			const addresses = await this.resolver.resolveHost(url.hostname);

			let response: Response | undefined;
			let lastError: unknown;

			for (const address of addresses) {
				const pinnedUrl = new URL(currentUrl);
				const isIpv6 = address.includes(":");
				pinnedUrl.hostname = isIpv6 ? `[${address}]` : address;

				const init: RequestInit & { tls?: { serverName?: string } } = {
					method,
					headers: {
						...headers,
						Host: url.port ? `${url.hostname}:${url.port}` : url.hostname,
					},
					body,
					redirect: "manual",
					signal: request.signal,
				};

				if (url.protocol === "https:") {
					init.tls = {
						serverName: url.hostname,
					};
				}

				try {
					response = await this.fetchFn(pinnedUrl.toString(), init);
					break;
				} catch (error) {
					if (request.signal?.aborted) throw error;
					lastError = error;
				}
			}

			if (!response) {
				throw lastError instanceof Error
					? lastError
					: new Error(String(lastError));
			}
			if (response.status < 300 || response.status >= 400) {
				return response;
			}

			const location = response.headers.get("location");
			if (!location) {
				return response;
			}

			if (redirectCount >= MAX_REDIRECT_HOPS) {
				throw new Error(`Too many redirects for ${request.url}`);
			}

			const redirectUrl = new URL(location, currentUrl);
			if (
				redirectUrl.protocol !== "http:" &&
				redirectUrl.protocol !== "https:"
			) {
				throw new Error(
					`Redirect to disallowed protocol: ${redirectUrl.protocol}`,
				);
			}

			await this.resolver.assertPublicHostname(redirectUrl.hostname);
			if (shouldRewriteRedirectToGet(response.status, method)) {
				method = "GET";
				body = undefined;
				headers = sanitizeRequestHeaders(headers, BODY_HEADERS);
			}
			if (url.origin !== redirectUrl.origin) {
				headers = sanitizeRequestHeaders(headers, ORIGIN_BOUND_HEADERS);
			}
			currentUrl = redirectUrl.toString();
			redirectCount += 1;
		}
	}
}

function sanitizeRequestHeaders(
	headers: Record<string, string>,
	forbiddenNames: ReadonlySet<string> = new Set(["host"]),
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).filter(
			([name]) => !forbiddenNames.has(name.toLowerCase()),
		),
	);
}

function shouldRewriteRedirectToGet(status: number, method: string): boolean {
	return (
		REDIRECT_TO_GET_STATUSES.has(status) &&
		method !== "GET" &&
		method !== "HEAD"
	);
}

export function securityPlugin(
	resolver: Resolver = new DefaultResolver(),
	httpClient: HttpClient = new PinnedHttpClient(resolver),
) {
	return new Elysia({ name: "security-plugin" })
		.decorate("resolver", resolver)
		.decorate("httpClient", httpClient);
}

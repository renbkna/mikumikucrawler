import { lookup } from "node:dns/promises";
import net from "node:net";
import { Elysia } from "elysia";
import { LRUCache } from "lru-cache";
import { normalizeRobotsMatchHttpUrl } from "../../shared/url.js";
import { isInvalidIpAddress } from "../utils/ipValidation.js";
import { disposeResponseBody } from "../utils/responseBody.js";

const RESOLUTION_TTL_MS = 5 * 60 * 1000;
const RESOLUTION_CACHE_MAX_ENTRIES = 512;
const MAX_REDIRECT_HOPS = 10;
const REDIRECT_TO_GET_STATUSES = new Set([301, 302, 303]);
const ORIGIN_BOUND_HEADERS = new Set(["authorization", "cookie", "host", "proxy-authorization"]);
const BODY_HEADERS = new Set(["content-length", "content-type"]);

export interface Resolver {
	resolveHost(hostname: string, options?: { allowLocalhost?: boolean }): Promise<readonly string[]>;
	assertPublicHostname(hostname: string): Promise<void>;
}

export interface HttpClientRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: BodyInit;
	signal?: AbortSignal;
	redirect?: RequestRedirect;
	/** Grants localhost only to this request's first hop; redirects remain public-only. */
	allowLocalhostOnInitialRequest?: boolean;
}

export interface HttpClient {
	fetch(request: HttpClientRequest): Promise<Response>;
}

export class DefaultResolver implements Resolver {
	private readonly cache = new LRUCache<string, readonly string[]>({
		max: RESOLUTION_CACHE_MAX_ENTRIES,
		ttl: RESOLUTION_TTL_MS,
	});
	private readonly inFlightResolutions = new Map<string, Promise<readonly string[]>>();

	constructor(
		private readonly lookupFn: typeof lookup = lookup,
		private readonly allowLocalhost = false,
	) {}

	async assertPublicHostname(hostname: string): Promise<void> {
		await this.resolveHost(hostname, { allowLocalhost: false });
	}

	async resolveHost(
		hostname: string,
		options: { allowLocalhost?: boolean } = {},
	): Promise<readonly string[]> {
		if (!hostname) {
			throw new Error("Target host is empty");
		}

		const normalizedHost =
			hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

		if (normalizedHost.toLowerCase() === "localhost") {
			if (this.allowLocalhost && options.allowLocalhost === true) {
				return Object.freeze(["127.0.0.1"]);
			}
			throw new Error("Localhost targets are not allowed");
		}

		const ipType = net.isIP(normalizedHost);
		if (ipType > 0) {
			if (isInvalidIpAddress(normalizedHost)) {
				throw new Error(`Private or reserved IP address: ${normalizedHost}`);
			}

			return Object.freeze([normalizedHost]);
		}

		const cached = this.cache.get(normalizedHost);
		if (cached) {
			return cached;
		}

		let pending = this.inFlightResolutions.get(normalizedHost);
		if (!pending) {
			pending = this.lookupFn(normalizedHost, {
				all: true,
				verbatim: false,
			})
				.then((records) => {
					const addresses = records.map((record) => record.address);

					if (addresses.length === 0) {
						throw new Error(`No DNS records for ${normalizedHost}`);
					}

					if (addresses.some((address) => isInvalidIpAddress(address))) {
						throw new Error(`Hostname ${normalizedHost} resolves to a private or reserved IP`);
					}

					const immutableAddresses = Object.freeze(addresses);
					this.cache.set(normalizedHost, immutableAddresses);
					return immutableAddresses;
				})
				.finally(() => {
					if (this.inFlightResolutions.get(normalizedHost) === pending) {
						this.inFlightResolutions.delete(normalizedHost);
					}
				});
			this.inFlightResolutions.set(normalizedHost, pending);
		}

		return pending;
	}
}

export class PinnedHttpClient implements HttpClient {
	constructor(
		private readonly resolver: Resolver,
		private readonly fetchFn: typeof fetch = globalThis.fetch,
	) {}

	async fetch(request: HttpClientRequest): Promise<Response> {
		const seenUrls = new Set<string>();
		let currentUrl = normalizeOutboundUrl(request.url);
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
			const addresses = await this.resolver.resolveHost(url.hostname, {
				allowLocalhost: redirectCount === 0 && request.allowLocalhostOnInitialRequest === true,
			});

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
				throw lastError instanceof Error ? lastError : new Error(String(lastError));
			}
			if (response.status < 300 || response.status >= 400) {
				return withEffectiveUrl(response, currentUrl);
			}

			const location = response.headers.get("location");
			if (!location) {
				return withEffectiveUrl(response, currentUrl);
			}
			await disposeResponseBody(response);

			if (redirectCount >= MAX_REDIRECT_HOPS) {
				throw new Error(`Too many redirects for ${request.url}`);
			}

			const redirectUrl = new URL(location, currentUrl);
			const normalizedRedirectUrl = normalizeOutboundUrl(redirectUrl.toString());
			const validatedRedirectUrl = new URL(normalizedRedirectUrl);

			await this.resolver.assertPublicHostname(validatedRedirectUrl.hostname);
			if (shouldRewriteRedirectToGet(response.status, method)) {
				method = "GET";
				body = undefined;
				headers = sanitizeRequestHeaders(headers, BODY_HEADERS);
			}
			if (url.origin !== validatedRedirectUrl.origin) {
				headers = sanitizeRequestHeaders(headers, ORIGIN_BOUND_HEADERS);
			}
			currentUrl = normalizedRedirectUrl;
			redirectCount += 1;
		}
	}
}

function withEffectiveUrl(response: Response, effectiveUrl: string): Response {
	Object.defineProperty(response, "url", {
		value: effectiveUrl,
		configurable: false,
		enumerable: true,
	});
	return response;
}

function normalizeOutboundUrl(url: string): string {
	const normalized = normalizeRobotsMatchHttpUrl(url);
	if ("error" in normalized) {
		throw new Error(normalized.error);
	}
	return normalized.url;
}

function sanitizeRequestHeaders(
	headers: Record<string, string>,
	forbiddenNames: ReadonlySet<string> = new Set(["host"]),
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) => !forbiddenNames.has(name.toLowerCase())),
	);
}

function shouldRewriteRedirectToGet(status: number, method: string): boolean {
	return REDIRECT_TO_GET_STATUSES.has(status) && method !== "GET" && method !== "HEAD";
}

export function securityPlugin(
	resolver: Resolver = new DefaultResolver(),
	httpClient: HttpClient = new PinnedHttpClient(resolver),
) {
	return new Elysia({ name: "security-plugin" })
		.decorate("resolver", resolver)
		.decorate("httpClient", httpClient);
}

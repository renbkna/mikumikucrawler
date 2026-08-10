import { lookup } from "node:dns/promises";
import net from "node:net";
import { LRUCache } from "lru-cache";
import { CookieJar } from "tough-cookie";
import { isPublicIpAddressLiteral } from "../../shared/ipPolicy.js";
import { normalizeCanonicalHttpUrl } from "../../shared/url.js";
import { disposeResponseBody } from "../utils/responseBody.js";

const RESOLUTION_TTL_MS = 5 * 60 * 1000;
const RESOLUTION_CACHE_MAX_ENTRIES = 512;
const MAX_REDIRECT_HOPS = 10;
const FOLLOW_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ORIGIN_BOUND_HEADERS = new Set(["authorization", "cookie", "host", "proxy-authorization"]);

type DnsLookupRecord = { address: string; family: number };
type LookupAll = (
	hostname: string,
	options: { all: true; verbatim: false },
) => Promise<DnsLookupRecord[]>;

export interface Resolver {
	resolveHost(hostname: string, options?: ResolveHostOptions): Promise<readonly string[]>;
	assertPublicHostname(hostname: string, signal?: AbortSignal): Promise<void>;
}

interface ResolveHostOptions {
	allowLocalhost?: boolean;
	signal?: AbortSignal;
}

type OutboundPolicyCode =
	| "crawl-policy"
	| "empty-host"
	| "invalid-url"
	| "localhost-denied"
	| "private-address";

export class OutboundPolicyError extends Error {
	constructor(
		readonly code: OutboundPolicyCode,
		message: string,
	) {
		super(message);
		this.name = "OutboundPolicyError";
	}
}

export function isOutboundPolicyError(error: unknown): error is OutboundPolicyError {
	return error instanceof OutboundPolicyError;
}

interface RedirectHop {
	fromUrl: string;
	toUrl: string;
	statusCode: number;
	hopNumber: number;
}

interface HttpClientRequest {
	url: string;
	method?: "GET" | "HEAD";
	headers?: Record<string, string>;
	signal?: AbortSignal;
	redirect?: "manual";
	/** Grants localhost only to this request's first hop; redirects remain public-only. */
	allowLocalhostOnInitialRequest?: boolean;
	/** Must authorize a normalized, public redirect destination before it is requested. */
	authorizeRedirect?: (hop: RedirectHop, signal?: AbortSignal) => Promise<void> | void;
}

export interface HttpClient {
	fetch(request: HttpClientRequest): Promise<Response>;
}

export class DefaultResolver implements Resolver {
	private readonly cache = new LRUCache<string, readonly string[]>({
		max: RESOLUTION_CACHE_MAX_ENTRIES,
		ttl: RESOLUTION_TTL_MS,
	});
	private readonly inFlightResolutions = new Map<string, Promise<DnsLookupRecord[]>>();

	constructor(
		private readonly lookupFn: LookupAll = lookup as LookupAll,
		private readonly allowLocalhost = false,
	) {}

	async assertPublicHostname(hostname: string, signal?: AbortSignal): Promise<void> {
		await this.resolveHost(hostname, { allowLocalhost: false, signal });
	}

	async resolveHost(
		hostname: string,
		options: ResolveHostOptions = {},
	): Promise<readonly string[]> {
		options.signal?.throwIfAborted();
		if (!hostname) {
			throw new OutboundPolicyError("empty-host", "Target host is empty");
		}

		const normalizedHost = (
			hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
		)
			.toLowerCase()
			.replace(/\.$/, "");

		if (normalizedHost === "localhost") {
			if (this.allowLocalhost && options.allowLocalhost === true) {
				return Object.freeze(["127.0.0.1"]);
			}
			throw new OutboundPolicyError("localhost-denied", "Localhost targets are not allowed");
		}

		const ipType = net.isIP(normalizedHost);
		if (ipType > 0) {
			if (!isPublicIpAddressLiteral(normalizedHost)) {
				throw new OutboundPolicyError(
					"private-address",
					`Private or reserved IP address: ${normalizedHost}`,
				);
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
			}).finally(() => {
				if (this.inFlightResolutions.get(normalizedHost) === pending) {
					this.inFlightResolutions.delete(normalizedHost);
				}
			});
			this.inFlightResolutions.set(normalizedHost, pending);
		}

		const records = await waitForAbort(pending, options.signal, "DNS resolution aborted");
		options.signal?.throwIfAborted();
		const addresses = records.map((record) => record.address);
		if (addresses.length === 0) {
			throw new Error(`No DNS records for ${normalizedHost}`);
		}
		if (addresses.some((address) => !isPublicIpAddressLiteral(address))) {
			throw new OutboundPolicyError(
				"private-address",
				`Hostname ${normalizedHost} resolves to a private or reserved IP`,
			);
		}

		const immutableAddresses = Object.freeze(addresses);
		this.cache.set(normalizedHost, immutableAddresses);
		return immutableAddresses;
	}
}

export class PinnedHttpClient implements HttpClient {
	constructor(
		private readonly resolver: Resolver,
		private readonly fetchFn: typeof fetch = globalThis.fetch,
	) {}

	async fetch(request: HttpClientRequest): Promise<Response> {
		request.signal?.throwIfAborted();
		const seenUrls = new Set<string>();
		let currentUrl = normalizeOutboundUrl(request.url);
		let redirectCount = 0;
		const method = request.method ?? "GET";
		const headers = new Headers(request.headers);
		headers.delete("host");
		const cookieJar = new CookieJar();
		const initialCookie = headers.get("cookie");
		headers.delete("cookie");
		if (initialCookie) {
			const secure = new URL(currentUrl).protocol === "https:" ? "; Secure" : "";
			for (const cookiePair of initialCookie.split(";")) {
				const trimmed = cookiePair.trim();
				if (trimmed)
					await cookieJar.setCookie(`${trimmed}; Path=/${secure}`, currentUrl, {
						ignoreError: true,
					});
			}
		}

		for (;;) {
			request.signal?.throwIfAborted();
			if (seenUrls.has(currentUrl)) {
				throw new Error(`Redirect loop detected for ${currentUrl}`);
			}
			seenUrls.add(currentUrl);

			const url = new URL(currentUrl);
			const addresses = await this.resolver.resolveHost(url.hostname, {
				allowLocalhost: redirectCount === 0 && request.allowLocalhostOnInitialRequest === true,
				signal: request.signal,
			});

			let response: Response | undefined;
			let lastError: unknown;

			for (const address of addresses) {
				const pinnedUrl = new URL(currentUrl);
				const isIpv6 = address.includes(":");
				pinnedUrl.hostname = isIpv6 ? `[${address}]` : address;

				const cookie = await cookieJar.getCookieString(currentUrl);
				const requestHeaders = new Headers(headers);
				if (cookie) requestHeaders.set("cookie", cookie);
				requestHeaders.set("host", url.port ? `${url.hostname}:${url.port}` : url.hostname);
				const init: RequestInit & { tls?: { serverName?: string } } = {
					method,
					headers: requestHeaders,
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
					request.signal?.throwIfAborted();
					lastError = error;
				}
			}

			if (!response) {
				throw lastError instanceof Error ? lastError : new Error(String(lastError));
			}
			for (const setCookie of response.headers.getSetCookie()) {
				await cookieJar.setCookie(setCookie, currentUrl, { ignoreError: true });
			}
			if (!FOLLOW_REDIRECT_STATUSES.has(response.status)) {
				return withEffectiveUrl(response, currentUrl);
			}

			const location = response.headers.get("location");
			if (!location) {
				return withEffectiveUrl(response, currentUrl);
			}

			if (redirectCount >= MAX_REDIRECT_HOPS) {
				await disposeResponseBody(response);
				throw new Error(`Too many redirects for ${request.url}`);
			}

			let normalizedRedirectUrl: string;
			let validatedRedirectUrl: URL;
			try {
				const redirectUrl = new URL(location, currentUrl);
				normalizedRedirectUrl = normalizeOutboundUrl(redirectUrl.toString());
				validatedRedirectUrl = new URL(normalizedRedirectUrl);

				await this.resolver.assertPublicHostname(validatedRedirectUrl.hostname, request.signal);
				await request.authorizeRedirect?.(
					{
						fromUrl: currentUrl,
						toUrl: normalizedRedirectUrl,
						statusCode: response.status,
						hopNumber: redirectCount + 1,
					},
					request.signal,
				);
			} catch (error) {
				await disposeResponseBody(response);
				throw error;
			}

			if (request.redirect === "manual") {
				return withRedirectLocation(response, currentUrl, normalizedRedirectUrl);
			}

			await disposeResponseBody(response);
			if (url.origin !== validatedRedirectUrl.origin) {
				for (const name of ORIGIN_BOUND_HEADERS) headers.delete(name);
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

function withRedirectLocation(
	response: Response,
	effectiveUrl: string,
	location: string,
): Response {
	const headers = new Headers(response.headers);
	headers.set("location", location);
	return withEffectiveUrl(
		new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		}),
		effectiveUrl,
	);
}

function normalizeOutboundUrl(url: string): string {
	const normalized = normalizeCanonicalHttpUrl(url);
	if ("error" in normalized) {
		throw new OutboundPolicyError("invalid-url", normalized.error);
	}
	return normalized.url;
}

function waitForAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	fallback: string,
): Promise<T> {
	if (!signal) return promise;
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason instanceof Error ? signal.reason : new Error(fallback));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

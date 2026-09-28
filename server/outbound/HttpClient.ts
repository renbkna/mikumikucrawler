import { lookup } from "node:dns/promises";
import net from "node:net";
import { LRUCache } from "lru-cache";
import { CookieJar } from "tough-cookie";
import { isPublicIpAddressLiteral, unbracketIpLiteral } from "../../shared/ipPolicy.js";
import { normalizeCanonicalHttpUrl, normalizeHostname } from "../../shared/url.js";
import { abortError, raceAbort } from "../utils/abort.js";
import { toError } from "../utils/helpers.js";
import { disposeResponseBody } from "../utils/responseBody.js";
import { SingleFlight } from "../utils/singleFlight.js";

const RESOLUTION_TTL_MS = 5 * 60 * 1000;
const RESOLUTION_CACHE_MAX_ENTRIES = 512;
const MAX_REDIRECT_HOPS = 10;
export const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
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

/** Methods that carry a request body; only rendered pages' own scripts send them. */
export type BodyMethod = "POST" | "PUT";

/** A read carries no body; a write sends the body its page script supplied. */
type HttpClientRequestMethod =
	| { method?: "GET" | "HEAD"; body?: never }
	| { method: BodyMethod; body?: Uint8Array<ArrayBuffer> };

type HttpClientRequest = HttpClientRequestMethod & {
	url: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	redirect?: "manual";
	/** Grants localhost only to this request's first hop; redirects remain public-only. */
	allowLocalhostOnInitialRequest?: boolean;
	/** Must authorize a normalized, public redirect destination before it is requested. */
	authorizeRedirect?: (hop: RedirectHop, signal?: AbortSignal) => Promise<void> | void;
};

/** Headers that describe a request body; a redirect that drops the body drops them too. */
const REQUEST_BODY_HEADERS = [
	"content-encoding",
	"content-language",
	"content-location",
	"content-type",
];

/**
 * The Fetch standard's redirect rule: 303 turns any write into GET, and 301/302 turn a
 * POST into GET, discarding the body; 307/308 repeat the request unchanged.
 */
function redirectRewritesToGet(status: number, method: string): boolean {
	return (
		(status === 303 && method !== "GET" && method !== "HEAD") ||
		((status === 301 || status === 302) && method === "POST")
	);
}

export interface HttpClient {
	fetch(request: HttpClientRequest): Promise<Response>;
}

export class DefaultResolver implements Resolver {
	private readonly cache = new LRUCache<string, readonly string[]>({
		max: RESOLUTION_CACHE_MAX_ENTRIES,
		ttl: RESOLUTION_TTL_MS,
	});
	private readonly inFlightResolutions = new SingleFlight<string, DnsLookupRecord[]>();

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

		const normalizedHost = normalizeHostname(unbracketIpLiteral(hostname));

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

		const pending = this.inFlightResolutions.run(normalizedHost, () =>
			this.lookupFn(normalizedHost, { all: true, verbatim: false }),
		);
		const records = await raceAbort(pending, options.signal, (signal) =>
			abortError(signal, "DNS resolution aborted"),
		);
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
		let method: string = request.method ?? "GET";
		let body = request.body;
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
					...(body ? { body } : {}),
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
				throw toError(lastError);
			}
			for (const setCookie of response.headers.getSetCookie()) {
				await cookieJar.setCookie(setCookie, currentUrl, { ignoreError: true });
			}
			if (!REDIRECT_STATUS_CODES.has(response.status)) {
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
			if (redirectRewritesToGet(response.status, method)) {
				method = "GET";
				body = undefined;
				for (const name of REQUEST_BODY_HEADERS) headers.delete(name);
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

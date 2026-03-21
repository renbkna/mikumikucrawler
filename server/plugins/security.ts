import { lookup } from "node:dns/promises";
import net from "node:net";
import { Elysia } from "elysia";
import { isInvalidIpAddress } from "../utils/ipValidation.js";
import { LRUCacheWithTTL } from "../utils/lruCache.js";

const RESOLUTION_TTL_MS = 5 * 60 * 1000;
const RESOLUTION_CACHE_MAX_ENTRIES = 512;

export interface Resolver {
	resolveHost(hostname: string): Promise<string[]>;
	assertPublicHostname(hostname: string): Promise<void>;
}

export interface HttpClientRequest {
	url: string;
	headers?: Record<string, string>;
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
		const url = new URL(request.url);
		const addresses = await this.resolver.resolveHost(url.hostname);
		const pinnedUrl = new URL(request.url);
		const selectedAddress = addresses[0];
		const isIpv6 = selectedAddress.includes(":");
		pinnedUrl.hostname = isIpv6 ? `[${selectedAddress}]` : selectedAddress;

		const init: RequestInit & { tls?: { serverName?: string } } = {
			headers: {
				...request.headers,
				Host: url.port ? `${url.hostname}:${url.port}` : url.hostname,
			},
			redirect: request.redirect ?? "follow",
			signal: request.signal,
		};

		if (url.protocol === "https:") {
			init.tls = {
				serverName: url.hostname,
			};
		}

		return this.fetchFn(pinnedUrl.toString(), init);
	}
}

export function securityPlugin(
	resolver: Resolver = new DefaultResolver(),
	httpClient: HttpClient = new PinnedHttpClient(resolver),
) {
	return new Elysia({ name: "security-plugin" })
		.decorate("resolver", resolver)
		.decorate("httpClient", httpClient);
}

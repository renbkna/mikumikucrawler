import { describe, expect, mock, test } from "bun:test";
import {
	DefaultResolver,
	PinnedHttpClient,
	type Resolver,
} from "../security.js";

describe("security contract", () => {
	test("allows public hostnames resolved by injected lookup", async () => {
		const resolver = new DefaultResolver(
			mock(async () => [{ address: "93.184.216.34", family: 4 }]) as never,
		);

		await expect(resolver.resolveHost("example.com")).resolves.toEqual([
			"93.184.216.34",
		]);
	});

	test("blocks mixed DNS answers containing a private IP", async () => {
		const resolver = new DefaultResolver(
			mock(async () => [
				{ address: "93.184.216.34", family: 4 },
				{ address: "10.0.0.5", family: 4 },
			]) as never,
		);

		await expect(resolver.resolveHost("mixed.example")).rejects.toThrow(
			"private or reserved IP",
		);
	});

	test("blocks direct private IP targets", async () => {
		const resolver = new DefaultResolver();
		await expect(resolver.resolveHost("127.0.0.1")).rejects.toThrow(
			"Private or reserved IP",
		);
	});

	test("pins fetches to the resolved IP while preserving host header and TLS server name", async () => {
		const resolver: Resolver = {
			assertPublicHostname: async () => {},
			resolveHost: async () => ["93.184.216.34"],
		};
		const fetchMock = mock(async () => new Response("ok"));
		const httpClient = new PinnedHttpClient(
			resolver,
			fetchMock as unknown as typeof fetch,
		);

		await httpClient.fetch({
			url: "https://example.com/docs",
			headers: { Accept: "text/html" },
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit & { tls?: { serverName?: string } },
		];
		expect(url).toBe("https://93.184.216.34/docs");
		expect((init.headers as Record<string, string>).Host).toBe("example.com");
		expect(init.tls?.serverName).toBe("example.com");
	});

	test("rejects non-http protocols before resolving or fetching", async () => {
		const resolver: Resolver = {
			assertPublicHostname: mock(async () => {}),
			resolveHost: mock(async () => ["93.184.216.34"]),
		};
		const fetchMock = mock(async () => new Response("ok"));
		const httpClient = new PinnedHttpClient(
			resolver,
			fetchMock as unknown as typeof fetch,
		);

		await expect(
			httpClient.fetch({
				url: "ftp://example.com/file",
			}),
		).rejects.toThrow("Disallowed protocol");
		expect(resolver.resolveHost).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("re-validates redirect targets before following them", async () => {
		const resolver: Resolver = {
			resolveHost: async () => ["93.184.216.34"],
			assertPublicHostname: async (hostname) => {
				if (hostname === "169.254.169.254") {
					throw new Error("Private or reserved IP address: 169.254.169.254");
				}
			},
		};
		const fetchMock = mock(
			async () =>
				new Response(null, {
					status: 302,
					headers: {
						location: "http://169.254.169.254/latest/meta-data/",
					},
				}),
		);
		const httpClient = new PinnedHttpClient(
			resolver,
			fetchMock as unknown as typeof fetch,
		);

		await expect(
			httpClient.fetch({
				url: "https://example.com/start",
			}),
		).rejects.toThrow("Private or reserved IP address");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("cross-origin redirects rewrite unsafe methods and strip origin-bound headers", async () => {
		const resolver: Resolver = {
			resolveHost: async () => ["93.184.216.34"],
			assertPublicHostname: async () => {},
		};
		const fetchMock = mock(async (url: string) =>
			url.includes("/start")
				? new Response(null, {
						status: 302,
						headers: { location: "https://other.example/landing" },
					})
				: new Response("ok"),
		);
		const httpClient = new PinnedHttpClient(
			resolver,
			fetchMock as unknown as typeof fetch,
		);

		await httpClient.fetch({
			url: "https://example.com/start",
			method: "POST",
			body: "secret-body",
			headers: {
				Authorization: "Bearer secret",
				Cookie: "session=secret",
				"Content-Type": "application/json",
				"X-Public": "kept",
			},
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [, secondInit] = fetchMock.mock.calls[1] as unknown as [
			string,
			RequestInit,
		];
		const secondHeaders = secondInit.headers as Record<string, string>;
		expect(secondInit.method).toBe("GET");
		expect(secondInit.body).toBeUndefined();
		expect(secondHeaders.Authorization).toBeUndefined();
		expect(secondHeaders.Cookie).toBeUndefined();
		expect(secondHeaders["Content-Type"]).toBeUndefined();
		expect(secondHeaders["X-Public"]).toBe("kept");
		expect(secondHeaders.Host).toBe("other.example");
	});

	for (const [status, expectedMethod, expectedBody] of [
		[301, "GET", undefined],
		[302, "GET", undefined],
		[303, "GET", undefined],
		[307, "POST", "payload"],
		[308, "POST", "payload"],
	] as const) {
		test(`applies browser redirect method semantics for ${status}`, async () => {
			const resolver: Resolver = {
				resolveHost: async () => ["93.184.216.34"],
				assertPublicHostname: async () => {},
			};
			const fetchMock = mock(async (url: string) =>
				url.endsWith("/start")
					? new Response(null, {
							status,
							headers: { location: "/next" },
						})
					: new Response("ok"),
			);
			const httpClient = new PinnedHttpClient(
				resolver,
				fetchMock as unknown as typeof fetch,
			);

			await httpClient.fetch({
				url: "https://example.com/start",
				method: "POST",
				body: "payload",
				headers: { "Content-Type": "text/plain" },
			});

			expect(fetchMock).toHaveBeenCalledTimes(2);
			const [, secondInit] = fetchMock.mock.calls[1] as unknown as [
				string,
				RequestInit,
			];
			expect(secondInit.method).toBe(expectedMethod);
			expect(secondInit.body).toBe(expectedBody);
		});
	}

	test("fails fast on redirect loops instead of following forever", async () => {
		const resolver: Resolver = {
			resolveHost: async () => ["93.184.216.34"],
			assertPublicHostname: async () => {},
		};
		const fetchMock = mock(
			async () =>
				new Response(null, {
					status: 302,
					headers: {
						location: "https://example.com/start",
					},
				}),
		);
		const httpClient = new PinnedHttpClient(
			resolver,
			fetchMock as unknown as typeof fetch,
		);

		await expect(
			httpClient.fetch({
				url: "https://example.com/start",
			}),
		).rejects.toThrow("Redirect loop detected");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("fails after the maximum redirect hop count", async () => {
		const resolver: Resolver = {
			resolveHost: async () => ["93.184.216.34"],
			assertPublicHostname: async () => {},
		};
		const fetchMock = mock(async (url: string) => {
			const current = new URL(url);
			const currentHop = Number.parseInt(current.pathname.slice(1) || "0", 10);
			return new Response(null, {
				status: 302,
				headers: {
					location: `https://example.com/${currentHop + 1}`,
				},
			});
		});
		const httpClient = new PinnedHttpClient(
			resolver,
			fetchMock as unknown as typeof fetch,
		);

		await expect(
			httpClient.fetch({
				url: "https://example.com/0",
			}),
		).rejects.toThrow("Too many redirects");
		expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
		expect(fetchMock.mock.calls.length).toBeLessThan(20);
	});
});

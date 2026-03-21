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
});

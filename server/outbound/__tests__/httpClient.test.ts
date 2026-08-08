import { describe, expect, mock, test } from "bun:test";
import { lookup } from "node:dns/promises";
import {
	DefaultResolver,
	OutboundPolicyError,
	PinnedHttpClient,
	type Resolver,
} from "../HttpClient.js";

describe("outbound HTTP contract", () => {
	test("allows public hostnames resolved by injected lookup", async () => {
		const resolver = new DefaultResolver(
			mock(async () => [{ address: "93.184.216.34", family: 4 }]) as never,
		);

		await expect(resolver.resolveHost("example.com")).resolves.toEqual(["93.184.216.34"]);
	});

	test("coalesces concurrent lookups for the same hostname", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const lookup = mock(async () => {
			await gate;
			return [{ address: "93.184.216.34", family: 4 }];
		});
		const resolver = new DefaultResolver(lookup as never);

		const first = resolver.resolveHost("example.com");
		const second = resolver.resolveHost("example.com");
		await Bun.sleep(0);

		expect(lookup).toHaveBeenCalledTimes(1);
		release();
		await expect(Promise.all([first, second])).resolves.toEqual([
			["93.184.216.34"],
			["93.184.216.34"],
		]);
	});

	test("aborted DNS waiters return promptly and cannot populate the cache", async () => {
		let release!: (records: Array<{ address: string; family: number }>) => void;
		const lookup = mock(
			() =>
				new Promise<Array<{ address: string; family: number }>>((resolve) => {
					release = resolve;
				}),
		);
		const resolver = new DefaultResolver(lookup);
		const controller = new AbortController();
		const pending = resolver.resolveHost("aborted.example", { signal: controller.signal });
		controller.abort(new Error("request deadline"));

		await expect(pending).rejects.toThrow("request deadline");
		release([{ address: "93.184.216.34", family: 4 }]);
		await Bun.sleep(0);
		const second = resolver.resolveHost("aborted.example");
		expect(lookup).toHaveBeenCalledTimes(2);
		release([{ address: "93.184.216.35", family: 4 }]);
		await expect(second).resolves.toEqual(["93.184.216.35"]);
	});

	test("does not expose mutable cached DNS answers", async () => {
		const resolver = new DefaultResolver(
			mock(async () => [{ address: "93.184.216.34", family: 4 }]) as never,
		);

		const first = await resolver.resolveHost("example.com");
		expect(Object.isFrozen(first)).toBe(true);
		expect(Reflect.set(first, 0, "127.0.0.1")).toBe(false);
		await expect(resolver.resolveHost("example.com")).resolves.toEqual(["93.184.216.34"]);
	});

	test("blocks mixed DNS answers containing a private IP", async () => {
		const resolver = new DefaultResolver(
			mock(async () => [
				{ address: "93.184.216.34", family: 4 },
				{ address: "10.0.0.5", family: 4 },
			]) as never,
		);

		await expect(resolver.resolveHost("mixed.example")).rejects.toThrow("private or reserved IP");
	});

	test("blocks direct private IP targets", async () => {
		const resolver = new DefaultResolver();
		const denial = resolver.resolveHost("127.0.0.1");
		await expect(denial).rejects.toBeInstanceOf(OutboundPolicyError);
		await expect(denial).rejects.toThrow("Private or reserved IP");
	});

	test("allows localhost when allowLocalhost is true", async () => {
		const resolver = new DefaultResolver(lookup, true);
		await expect(resolver.resolveHost("localhost", { allowLocalhost: true })).resolves.toEqual([
			"127.0.0.1",
		]);
	});

	test("blocks localhost when allowLocalhost is false", async () => {
		const resolver = new DefaultResolver(lookup, false);
		await expect(resolver.resolveHost("localhost")).rejects.toThrow(
			"Localhost targets are not allowed",
		);
	});

	test("pins fetches to the resolved IP while preserving host header and TLS server name", async () => {
		const resolver: Resolver = {
			assertPublicHostname: async () => {},
			resolveHost: async () => ["93.184.216.34"],
		};
		const fetchMock = mock(async () => new Response("ok"));
		const httpClient = new PinnedHttpClient(resolver, fetchMock as unknown as typeof fetch);

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
		expect(new Headers(init.headers).get("host")).toBe("example.com");
		expect(init.tls?.serverName).toBe("example.com");
	});

	test("preserves secure-prefixed browser cookies on the initial HTTPS request", async () => {
		const resolver: Resolver = {
			assertPublicHostname: async () => {},
			resolveHost: async () => ["93.184.216.34"],
		};
		const fetchMock = mock(async (_url: string, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("cookie")).toBe("__Host-session=secret");
			return new Response("ok");
		});

		await new PinnedHttpClient(resolver, fetchMock as unknown as typeof fetch).fetch({
			url: "https://example.com/private",
			headers: { Cookie: "__Host-session=secret" },
		});
	});

	test("rejects non-http protocols before resolving or fetching", async () => {
		const resolver: Resolver = {
			assertPublicHostname: mock(async () => {}),
			resolveHost: mock(async () => ["93.184.216.34"]),
		};
		const fetchMock = mock(async () => new Response("ok"));
		const httpClient = new PinnedHttpClient(resolver, fetchMock as unknown as typeof fetch);

		await expect(
			httpClient.fetch({
				url: "ftp://example.com/file",
			}),
		).rejects.toThrow("Only HTTP and HTTPS URLs are supported");
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
		const httpClient = new PinnedHttpClient(resolver, fetchMock as unknown as typeof fetch);

		await expect(
			httpClient.fetch({
				url: "https://example.com/start",
			}),
		).rejects.toThrow("Private or reserved IP address");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("exposes the validated logical URL after redirects", async () => {
		const resolver: Resolver = {
			resolveHost: async () => ["93.184.216.34"],
			assertPublicHostname: async () => {},
		};
		const fetchMock = mock(async (url: string) =>
			url.includes("/start")
				? new Response(null, {
						status: 302,
						headers: { location: "https://final.example/docs/" },
					})
				: new Response("ok"),
		);
		const client = new PinnedHttpClient(resolver, fetchMock as unknown as typeof fetch);

		const response = await client.fetch({ url: "https://example.com/start" });

		expect(response.url).toBe("https://final.example/docs/");
	});

	test("returns an authorized absolute redirect for controlled browser navigation", async () => {
		const resolver: Resolver = {
			resolveHost: async () => ["93.184.216.34"],
			assertPublicHostname: mock(async () => {}),
		};
		const fetchMock = mock(
			async () => new Response(null, { status: 302, headers: { location: "/final" } }),
		);
		const authorizeRedirect = mock(async () => {});
		const client = new PinnedHttpClient(resolver, fetchMock as unknown as typeof fetch);

		const response = await client.fetch({
			url: "https://example.com/start",
			redirect: "manual",
			authorizeRedirect,
		});

		expect(response.status).toBe(302);
		expect(response.url).toBe("https://example.com/start");
		expect(response.headers.get("location")).toBe("https://example.com/final");
		expect(authorizeRedirect).toHaveBeenCalledWith(
			{
				fromUrl: "https://example.com/start",
				toUrl: "https://example.com/final",
				statusCode: 302,
				hopNumber: 1,
			},
			undefined,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("authorizes every redirect before dispatching its destination", async () => {
		const resolver: Resolver = {
			resolveHost: async () => ["93.184.216.34"],
			assertPublicHostname: async () => {},
		};
		const fetchMock = mock(async (url: string) =>
			url.includes("/start")
				? new Response(null, { status: 302, headers: { location: "https://other.example/" } })
				: new Response("must not run"),
		);
		const client = new PinnedHttpClient(resolver, fetchMock as unknown as typeof fetch);

		await expect(
			client.fetch({
				url: "https://example.com/start",
				authorizeRedirect: ({ toUrl }) => {
					throw new OutboundPolicyError("crawl-policy", `denied ${toUrl}`);
				},
			}),
		).rejects.toThrow("denied https://other.example/");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("carries redirect response cookies into the next eligible request", async () => {
		const resolver: Resolver = {
			resolveHost: async () => ["93.184.216.34"],
			assertPublicHostname: async () => {},
		};
		const fetchMock = mock(async (url: string, init?: RequestInit) => {
			if (url.includes("/start")) {
				return new Response(null, {
					status: 302,
					headers: { location: "/final", "set-cookie": "redirect=kept; Path=/; HttpOnly" },
				});
			}
			expect(new Headers(init?.headers).get("cookie")).toBe("redirect=kept");
			return new Response("ok");
		});
		const client = new PinnedHttpClient(resolver, fetchMock as unknown as typeof fetch);

		await client.fetch({ url: "https://example.com/start" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	for (const status of [300, 304, 305, 306]) {
		test(`does not follow non-redirect ${status} responses with Location`, async () => {
			const resolver: Resolver = {
				resolveHost: async () => ["93.184.216.34"],
				assertPublicHostname: mock(async () => {}),
			};
			const fetchMock = mock(
				async () => new Response(null, { status, headers: { location: "/unexpected" } }),
			);
			const client = new PinnedHttpClient(resolver, fetchMock as unknown as typeof fetch);

			const response = await client.fetch({ url: "https://example.com/start" });

			expect(response.status).toBe(status);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(resolver.assertPublicHostname).not.toHaveBeenCalled();
		});
	}

	test("cancels redirect bodies before following the next hop", async () => {
		let canceled = false;
		const resolver: Resolver = {
			resolveHost: async () => ["93.184.216.34"],
			assertPublicHostname: async () => {},
		};
		const fetchMock = mock(async (url: string) => {
			if (!url.includes("/start")) return new Response("ok");
			return new Response(
				new ReadableStream({
					cancel() {
						canceled = true;
					},
				}),
				{ status: 302, headers: { location: "/final" } },
			);
		});
		const client = new PinnedHttpClient(resolver, fetchMock as unknown as typeof fetch);

		await client.fetch({ url: "https://example.com/start" });

		expect(canceled).toBe(true);
	});

	test("limits localhost capability to an explicitly marked first hop", async () => {
		const resolveHost = mock(async (hostname: string, options?: { allowLocalhost?: boolean }) => {
			if (hostname === "localhost" && options?.allowLocalhost !== true) {
				throw new Error("Localhost targets are not allowed");
			}
			return [hostname === "localhost" ? "127.0.0.1" : "93.184.216.34"];
		});
		const resolver: Resolver = {
			resolveHost,
			assertPublicHostname: async (hostname) => {
				if (hostname === "localhost") throw new Error("Localhost targets are not allowed");
			},
		};
		const seedClient = new PinnedHttpClient(
			resolver,
			mock(async () => new Response("local seed")) as unknown as typeof fetch,
		);

		await expect(
			seedClient.fetch({
				url: "http://localhost:3000/",
				allowLocalhostOnInitialRequest: true,
			}),
		).resolves.toBeInstanceOf(Response);

		const redirectClient = new PinnedHttpClient(
			resolver,
			mock(
				async () =>
					new Response(null, { status: 302, headers: { location: "http://localhost/admin" } }),
			) as unknown as typeof fetch,
		);
		await expect(
			redirectClient.fetch({
				url: "https://example.com/start",
				allowLocalhostOnInitialRequest: true,
			}),
		).rejects.toThrow("Localhost targets are not allowed");
	});

	test("cross-origin redirects strip origin-bound headers", async () => {
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
		const httpClient = new PinnedHttpClient(resolver, fetchMock as unknown as typeof fetch);

		await httpClient.fetch({
			url: "https://example.com/start",
			headers: {
				Authorization: "Bearer secret",
				Cookie: "session=secret",
				"X-Public": "kept",
			},
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [, secondInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
		const secondHeaders = new Headers(secondInit.headers);
		expect(secondInit.method).toBe("GET");
		expect(secondHeaders.get("authorization")).toBeNull();
		expect(secondHeaders.get("cookie")).toBeNull();
		expect(secondHeaders.get("x-public")).toBe("kept");
		expect(secondHeaders.get("host")).toBe("other.example");
	});

	for (const method of ["GET", "HEAD"] as const) {
		test(`preserves crawler ${method} across redirects`, async () => {
			const resolver: Resolver = {
				resolveHost: async () => ["93.184.216.34"],
				assertPublicHostname: async () => {},
			};
			const fetchMock = mock(async (url: string) =>
				url.endsWith("/start")
					? new Response(null, {
							status: 302,
							headers: { location: "/next" },
						})
					: new Response("ok"),
			);
			const httpClient = new PinnedHttpClient(resolver, fetchMock as unknown as typeof fetch);

			await httpClient.fetch({
				url: "https://example.com/start",
				method,
			});

			expect(fetchMock).toHaveBeenCalledTimes(2);
			const [, secondInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
			expect(secondInit.method).toBe(method);
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
		const httpClient = new PinnedHttpClient(resolver, fetchMock as unknown as typeof fetch);

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
		const httpClient = new PinnedHttpClient(resolver, fetchMock as unknown as typeof fetch);

		await expect(
			httpClient.fetch({
				url: "https://example.com/0",
			}),
		).rejects.toThrow("Too many redirects");
		expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
		expect(fetchMock.mock.calls.length).toBeLessThan(20);
	});
});

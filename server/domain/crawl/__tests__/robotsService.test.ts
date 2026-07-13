import { describe, expect, mock, test } from "bun:test";
import type { Logger } from "../../../config/logging.js";
import { DOMAIN_DELAY_CONSTANTS, REQUEST_CONSTANTS } from "../../../constants.js";
import { RobotsService } from "../RobotsService.js";

function createLogger(): Logger {
	return {
		level: "info",
		info: mock(() => undefined),
		warn: mock(() => undefined),
		error: mock(() => undefined),
		debug: mock(() => undefined),
		fatal: mock(() => undefined),
		trace: mock(() => undefined),
		silent: mock(() => undefined),
		child: mock(() => createLogger()),
	} as unknown as Logger;
}

describe("RobotsService", () => {
	test("separates transient robots fetch failures from robots denial", async () => {
		const fetch = mock(async () => {
			if (fetch.mock.calls.length === 1) {
				throw new Error("temporary outage");
			}

			return new Response("User-agent: *\nDisallow: /private", {
				status: 200,
			});
		});
		const service = new RobotsService({ fetch }, createLogger());

		await expect(service.evaluate("https://example.com/private")).resolves.toEqual({
			type: "unavailable",
			delayKey: "https://example.com",
			reason: "temporary outage",
		});
		await expect(service.evaluate("https://example.com/private")).resolves.toEqual({
			type: "disallowed",
			delayKey: "https://example.com",
			crawlDelayMs: undefined,
		});
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test("caches explicit missing robots.txt as allow-all", async () => {
		const fetch = mock(async () => new Response("not found", { status: 404 }));
		const service = new RobotsService({ fetch }, createLogger());

		await expect(
			service.evaluate("https://example.com/anything").then((policy) => policy.type),
		).resolves.toBe("allowed");
		await expect(
			service.evaluate("https://example.com/anything-else").then((policy) => policy.type),
		).resolves.toBe("allowed");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("treats denied robots fetches as unavailable policy", async () => {
		const fetch = mock(async () => new Response("forbidden", { status: 403 }));
		const service = new RobotsService({ fetch }, createLogger());

		await expect(
			service.evaluate("https://example.com/anything").then((policy) => policy.type),
		).resolves.toBe("unavailable");
		await expect(
			service.evaluate("https://example.com/anything-else").then((policy) => policy.type),
		).resolves.toBe("unavailable");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test("propagates caller aborts instead of converting them to allow-all", async () => {
		const controller = new AbortController();
		const fetch = mock(
			async ({ signal }: { signal?: AbortSignal }) =>
				new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => {
						reject(signal.reason);
					});
				}),
		);
		const service = new RobotsService({ fetch }, createLogger());

		const evaluation = service.evaluate("https://example.com/private", controller.signal);
		controller.abort(new Error("force stop"));

		await expect(evaluation).rejects.toThrow("force stop");
	});

	test("evaluates robots rules against original path and query instead of crawl identity", async () => {
		const fetch = mock(
			async () =>
				new Response("User-agent: *\nDisallow: /search?b=2&a=1", {
					status: 200,
				}),
		);
		const service = new RobotsService({ fetch }, createLogger());

		await expect(
			service.evaluate("https://example.com/search?b=2&a=1").then((policy) => policy.type),
		).resolves.toBe("disallowed");
	});

	test("returns an origin-scoped crawl-delay key", async () => {
		const fetch = mock(
			async () =>
				new Response("User-agent: *\nCrawl-delay: 2", {
					status: 200,
				}),
		);
		const service = new RobotsService({ fetch }, createLogger());

		const policy = await service.evaluate("http://example.com:8080/page");

		expect(policy).toMatchObject({
			type: "allowed",
			crawlDelayMs: 2000,
			delayKey: "http://example.com:8080",
		});
	});

	test("rejects declared and streamed oversized robots bodies", async () => {
		let streamedCanceled = false;
		const responses = [
			new Response("unused", {
				headers: { "content-length": String(REQUEST_CONSTANTS.MAX_ROBOTS_RESPONSE_BYTES + 1) },
			}),
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(REQUEST_CONSTANTS.MAX_ROBOTS_RESPONSE_BYTES));
						controller.enqueue(new Uint8Array(1));
					},
					cancel() {
						streamedCanceled = true;
					},
				}),
			),
		];
		const service = new RobotsService(
			{ fetch: mock(async () => responses.shift() ?? new Response()) },
			createLogger(),
		);

		await expect(service.evaluate("https://one.example/page")).resolves.toMatchObject({
			type: "unavailable",
		});
		await expect(service.evaluate("https://two.example/page")).resolves.toMatchObject({
			type: "unavailable",
		});
		expect(streamedCanceled).toBe(true);
	});

	test("does not emit non-finite or above-ceiling robots delays", async () => {
		for (const value of ["1e306", String(DOMAIN_DELAY_CONSTANTS.MAX_MS / 1000 + 1)]) {
			const service = new RobotsService(
				{
					fetch: mock(async () => new Response(`User-agent: *\nCrawl-delay: ${value}`)),
				},
				createLogger(),
			);

			await expect(service.evaluate("https://example.com/page")).resolves.toMatchObject({
				type: "unavailable",
				reason: `robots.txt crawl-delay exceeds ${DOMAIN_DELAY_CONSTANTS.MAX_MS}ms`,
			});
		}
	});
});

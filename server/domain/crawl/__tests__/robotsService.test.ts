import { describe, expect, mock, test } from "bun:test";
import type { Logger } from "../../../config/logging.js";
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

		await expect(
			service.evaluate("https://example.com/private"),
		).resolves.toEqual({
			type: "unavailable",
			delayKey: "https://example.com",
			reason: "temporary outage",
		});
		await expect(
			service.evaluate("https://example.com/private"),
		).resolves.toEqual({
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
			service
				.evaluate("https://example.com/anything")
				.then((policy) => policy.type),
		).resolves.toBe("allowed");
		await expect(
			service
				.evaluate("https://example.com/anything-else")
				.then((policy) => policy.type),
		).resolves.toBe("allowed");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("treats denied robots fetches as unavailable policy", async () => {
		const fetch = mock(async () => new Response("forbidden", { status: 403 }));
		const service = new RobotsService({ fetch }, createLogger());

		await expect(
			service
				.evaluate("https://example.com/anything")
				.then((policy) => policy.type),
		).resolves.toBe("unavailable");
		await expect(
			service
				.evaluate("https://example.com/anything-else")
				.then((policy) => policy.type),
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

		const evaluation = service.evaluate(
			"https://example.com/private",
			controller.signal,
		);
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
			service
				.evaluate("https://example.com/search?b=2&a=1")
				.then((policy) => policy.type),
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
});

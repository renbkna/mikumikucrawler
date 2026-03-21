import { describe, expect, mock, test } from "bun:test";
import type { Logger } from "../../config/logging.js";
import type { HttpClient, Resolver } from "../../plugins/security.js";
import { createInMemoryStorage } from "../../storage/db.js";
import { CrawlManager } from "../CrawlManager.js";
import { EventStream } from "../EventStream.js";
import { RuntimeRegistry } from "../RuntimeRegistry.js";

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

function createOptions(target = "https://example.com"): {
	target: string;
	crawlMethod: "links";
	crawlDepth: number;
	crawlDelay: number;
	maxPages: number;
	maxPagesPerDomain: number;
	maxConcurrentRequests: number;
	retryLimit: number;
	dynamic: boolean;
	respectRobots: boolean;
	contentOnly: boolean;
	saveMedia: boolean;
} {
	return {
		target,
		crawlMethod: "links",
		crawlDepth: 2,
		crawlDelay: 200,
		maxPages: 2,
		maxPagesPerDomain: 0,
		maxConcurrentRequests: 1,
		retryLimit: 0,
		dynamic: false,
		respectRobots: false,
		contentOnly: false,
		saveMedia: false,
	};
}

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean) {
	const timeoutAt = Date.now() + 5000;
	while (Date.now() < timeoutAt) {
		const value = read();
		if (predicate(value)) {
			return value;
		}
		await Bun.sleep(25);
	}

	throw new Error("Timed out waiting for condition");
}

function createManager(httpClient: HttpClient) {
	const storage = createInMemoryStorage();
	const eventStream = new EventStream();
	const registry = new RuntimeRegistry();
	const resolver: Resolver = {
		assertPublicHostname: async () => {},
		resolveHost: async () => ["93.184.216.34"],
	};

	return {
		storage,
		eventStream,
		registry,
		manager: new CrawlManager({
			logger: createLogger(),
			repos: storage.repos,
			eventStream,
			registry,
			resolver,
			httpClient,
		}),
	};
}

describe("crawl manager contract", () => {
	test("create -> run -> complete", async () => {
		const httpClient: HttpClient = {
			fetch: async () =>
				new Response("<html><body><main>Hello world</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		};
		const { manager, storage, eventStream } = createManager(httpClient);
		const created = manager.create(createOptions());

		const completed = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);

		expect(completed?.counters.pagesScanned).toBe(1);
		expect(completed?.counters.pagesScanned).toBe(
			(completed?.counters.successCount ?? 0) +
				(completed?.counters.failureCount ?? 0) +
				(completed?.counters.skippedCount ?? 0),
		);
		expect(storage.repos.pages.getVisitedUrls(created.id)).toEqual([
			"https://example.com/",
		]);
		expect(storage.repos.crawlRuns.getById(created.id)?.eventSequence).toBe(
			eventStream.getCurrentSequence(created.id),
		);
	});

	test("create -> stop -> stopped", async () => {
		let releaseFetch!: () => void;
		const httpClient: HttpClient = {
			fetch: () =>
				new Promise<Response>((resolve) => {
					releaseFetch = () =>
						resolve(
							new Response("<html><body><main>slow</main></body></html>", {
								status: 200,
								headers: { "content-type": "text/html" },
							}),
						);
				}),
		};
		const { manager, storage } = createManager(httpClient);
		const created = manager.create(createOptions("https://slow.example"));

		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "running",
		);
		manager.stop(created.id);
		releaseFetch();

		const stopped = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "stopped",
		);

		expect(stopped?.stopReason).toBe("Stop requested");
	});

	test("interruption -> resume", async () => {
		let aboutResolved = false;
		let releaseAbout!: () => void;
		const httpClient: HttpClient = {
			fetch: async ({ url }) => {
				if (url.endsWith("/")) {
					return new Response(
						"<html><body><a href='https://example.com/about'>About</a><main>home</main></body></html>",
						{
							status: 200,
							headers: { "content-type": "text/html" },
						},
					);
				}

				if (aboutResolved) {
					return new Response("<html><body><main>about</main></body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					});
				}

				return new Promise<Response>((resolve) => {
					releaseAbout = () => {
						aboutResolved = true;
						resolve(
							new Response("<html><body><main>about</main></body></html>", {
								status: 200,
								headers: { "content-type": "text/html" },
							}),
						);
					};
				});
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = manager.create(createOptions());

		await waitFor(
			() => typeof releaseAbout,
			(value) => value === "function",
		);

		const shutdownPromise = manager.shutdownAll();
		releaseAbout();
		await shutdownPromise;

		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "interrupted",
		);

		const resumed = manager.resume(created.id);
		expect(resumed).not.toBeNull();
		expect(["interrupted", "starting", "running"]).toContain(
			resumed?.status ?? "interrupted",
		);

		const completed = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed" && aboutResolved,
		);

		expect(completed?.counters.successCount).toBe(2);
	});

	test("resume does not reprocess previously failed URLs", async () => {
		let holdResolved = false;
		let releaseHold!: () => void;
		let badRequests = 0;
		const httpClient: HttpClient = {
			fetch: async ({ url }) => {
				if (url.endsWith("/")) {
					return new Response(
						"<html><body><a href='https://example.com/bad'>Bad</a><a href='https://example.com/hold'>Hold</a><main>home</main></body></html>",
						{
							status: 200,
							headers: { "content-type": "text/html" },
						},
					);
				}

				if (url.endsWith("/bad")) {
					badRequests += 1;
					return new Response("bad", { status: 500 });
				}

				if (holdResolved) {
					return new Response(
						"<html><body><a href='https://example.com/bad'>Bad</a><main>hold</main></body></html>",
						{
							status: 200,
							headers: { "content-type": "text/html" },
						},
					);
				}

				return new Promise<Response>((resolve) => {
					releaseHold = () => {
						holdResolved = true;
						resolve(
							new Response(
								"<html><body><a href='https://example.com/bad'>Bad</a><main>hold</main></body></html>",
								{
									status: 200,
									headers: { "content-type": "text/html" },
								},
							),
						);
					};
				});
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = manager.create({ ...createOptions(), maxPages: 5 });

		await waitFor(
			() => badRequests,
			(value) => value === 1,
		);
		await waitFor(
			() => typeof releaseHold,
			(value) => value === "function",
		);

		const shutdownPromise = manager.shutdownAll();
		releaseHold();
		await shutdownPromise;
		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "interrupted",
		);

		manager.resume(created.id);
		const completed = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed" && holdResolved,
		);

		expect(completed?.counters.failureCount).toBe(1);
		expect(badRequests).toBe(1);
	});

	test("interrupted crawls resume delayed retries from durable queue state", async () => {
		let rateAttempts = 0;
		const httpClient: HttpClient = {
			fetch: async ({ url }) => {
				if (url.endsWith("/")) {
					return new Response(
						"<html><body><a href='https://example.com/rate'>Rate</a><main>home</main></body></html>",
						{
							status: 200,
							headers: { "content-type": "text/html" },
						},
					);
				}

				rateAttempts += 1;
				if (rateAttempts === 1) {
					return new Response("", {
						status: 429,
						headers: { "retry-after": "1" },
					});
				}

				return new Response("<html><body><main>rate</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				});
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = manager.create({
			...createOptions(),
			maxPages: 5,
			retryLimit: 1,
		});

		await waitFor(
			() => storage.repos.crawlQueue.listPending(created.id),
			(items) =>
				items.some((item) => item.url.endsWith("/rate") && item.retries === 1),
		);

		await manager.shutdownAll();
		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "interrupted",
		);

		await Bun.sleep(1_050);
		manager.resume(created.id);

		const completed = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);

		expect(completed?.counters.successCount).toBe(2);
		expect(rateAttempts).toBe(2);
	});
});

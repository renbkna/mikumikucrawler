import { describe, expect, mock, test } from "bun:test";
import type { CrawlCounters } from "../../../shared/contracts/index.js";
import type { Logger } from "../../config/logging.js";
import type { HttpClient, Resolver } from "../../plugins/security.js";
import { createInMemoryStorage } from "../../storage/db.js";
import { CrawlManager, type ResumeCrawlResult } from "../CrawlManager.js";
import { CrawlRuntime } from "../CrawlRuntime.js";
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

function createManager(httpClient: HttpClient, resolverOverride?: Resolver) {
	const storage = createInMemoryStorage();
	const eventStream = new EventStream();
	const registry = new RuntimeRegistry();
	const resolver: Resolver = resolverOverride ?? {
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

	test("create returns the current persisted startup snapshot", async () => {
		let releaseFetch!: () => void;
		const httpClient: HttpClient = {
			fetch: () =>
				new Promise<Response>((resolve) => {
					releaseFetch = () =>
						resolve(
							new Response("<html><body><main>held</main></body></html>", {
								status: 200,
								headers: { "content-type": "text/html" },
							}),
						);
				}),
		};
		const { manager, storage, eventStream } = createManager(httpClient);

		const created = manager.create(createOptions("https://startup.example"));
		const persisted = storage.repos.crawlRuns.getById(created.id);
		if (!persisted) {
			throw new Error("Expected created crawl to be persisted");
		}

		expect(created.status).toBe(persisted.status);
		expect(created.eventSequence).toBe(persisted.eventSequence);
		expect(created.status).not.toBe("pending");
		await waitFor(
			() => typeof releaseFetch,
			(value) => value === "function",
		);
		releaseFetch();
		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);
	});

	test("non-progress SSE events do not force an immediate event_sequence write", async () => {
		const httpClient: HttpClient = {
			fetch: async () =>
				new Response("<html><body><main>Hello world</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		};
		const storage = createInMemoryStorage();
		const eventStream = new EventStream();
		const resolver: Resolver = {
			assertPublicHostname: async () => {},
			resolveHost: async () => ["93.184.216.34"],
		};
		const crawlId = "crawl-seq-check";
		storage.repos.crawlRuns.createRun(crawlId, "https://sequence.example", {
			...createOptions(),
			target: "https://sequence.example",
		});
		const observedPersistedSequence: number[] = [];
		const unsubscribe = eventStream.subscribe(crawlId, (event) => {
			if (event.type === "crawl.started") {
				observedPersistedSequence.push(
					storage.repos.crawlRuns.getById(event.crawlId)?.eventSequence ?? -1,
				);
			}
		});

		const runtime = new CrawlRuntime({
			crawlId,
			options: {
				...createOptions(),
				target: "https://sequence.example",
			},
			logger: createLogger(),
			repos: storage.repos,
			eventStream,
			resolver,
			httpClient,
			resume: false,
			onSettled: () => {},
		});
		await runtime.start();
		unsubscribe();

		const completed = await waitFor(
			() => storage.repos.crawlRuns.getById(crawlId),
			(run) => run?.status === "completed",
		);

		expect(observedPersistedSequence).toEqual([0]);
		expect(completed?.eventSequence).toBe(
			eventStream.getCurrentSequence(crawlId),
		);
	});

	test("progress event subscribers observe the persisted event sequence", async () => {
		const httpClient: HttpClient = {
			fetch: async () =>
				new Response("<html><body><main>Hello world</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		};
		const { manager, storage, eventStream } = createManager(httpClient);
		const created = manager.create(createOptions("https://progress.example"));
		const observedSequences: Array<{
			eventSequence: number;
			persistedSequence: number;
		}> = [];
		const unsubscribe = eventStream.subscribe(created.id, (event) => {
			if (event.type !== "crawl.progress") {
				return;
			}

			observedSequences.push({
				eventSequence: event.sequence,
				persistedSequence:
					storage.repos.crawlRuns.getById(created.id)?.eventSequence ?? -1,
			});
		});

		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);
		unsubscribe();

		expect(observedSequences.length).toBeGreaterThan(0);
		expect(
			observedSequences.every(
				(sequence) => sequence.persistedSequence >= sequence.eventSequence,
			),
		).toBe(true);
	});

	test("completed event subscribers observe the terminal persisted status", async () => {
		const httpClient: HttpClient = {
			fetch: async () =>
				new Response("<html><body><main>Hello world</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		};
		const storage = createInMemoryStorage();
		const eventStream = new EventStream();
		const resolver: Resolver = {
			assertPublicHostname: async () => {},
			resolveHost: async () => ["93.184.216.34"],
		};
		const crawlId = "crawl-completed-order";
		storage.repos.crawlRuns.createRun(crawlId, "https://complete.example", {
			...createOptions(),
			target: "https://complete.example",
		});
		let rowAtCompletedEvent: { status: string; eventSequence: number } | null =
			null;
		const unsubscribe = eventStream.subscribe(crawlId, (event) => {
			if (event.type !== "crawl.completed") {
				return;
			}

			const row = storage.repos.crawlRuns.getById(crawlId);
			rowAtCompletedEvent = row
				? { status: row.status, eventSequence: row.eventSequence }
				: null;
		});

		const runtime = new CrawlRuntime({
			crawlId,
			options: {
				...createOptions(),
				target: "https://complete.example",
			},
			logger: createLogger(),
			repos: storage.repos,
			eventStream,
			resolver,
			httpClient,
			resume: false,
			onSettled: () => {},
		});
		await runtime.start();
		unsubscribe();

		expect(
			rowAtCompletedEvent as { status: string; eventSequence: number } | null,
		).toEqual({
			status: "completed",
			eventSequence: eventStream.getCurrentSequence(crawlId),
		});
	});

	test("throwing completed event subscribers cannot change terminal crawl status", async () => {
		const httpClient: HttpClient = {
			fetch: async () =>
				new Response("<html><body><main>Hello world</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		};
		const storage = createInMemoryStorage();
		const eventStream = new EventStream();
		const resolver: Resolver = {
			assertPublicHostname: async () => {},
			resolveHost: async () => ["93.184.216.34"],
		};
		const crawlId = "crawl-throwing-completed-subscriber";
		storage.repos.crawlRuns.createRun(crawlId, "https://complete.example", {
			...createOptions(),
			target: "https://complete.example",
		});
		const unsubscribe = eventStream.subscribe(crawlId, (event) => {
			if (event.type === "crawl.completed") {
				throw new Error("subscriber failed");
			}
		});

		const runtime = new CrawlRuntime({
			crawlId,
			options: {
				...createOptions(),
				target: "https://complete.example",
			},
			logger: createLogger(),
			repos: storage.repos,
			eventStream,
			resolver,
			httpClient,
			resume: false,
			onSettled: () => {},
		});
		await runtime.start();
		unsubscribe();

		expect(storage.repos.crawlRuns.getById(crawlId)?.status).toBe("completed");
	});

	test("failed event subscribers observe the terminal persisted status", async () => {
		const httpClient: HttpClient = {
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		};
		const storage = createInMemoryStorage();
		const eventStream = new EventStream();
		const resolver: Resolver = {
			assertPublicHostname: async () => {
				throw new Error("resolver failed");
			},
			resolveHost: async () => ["93.184.216.34"],
		};
		const crawlId = "crawl-failed-order";
		storage.repos.crawlRuns.createRun(crawlId, "https://fail.example", {
			...createOptions(),
			target: "https://fail.example",
		});
		let rowAtFailedEvent: { status: string; eventSequence: number } | null =
			null;
		const unsubscribe = eventStream.subscribe(crawlId, (event) => {
			if (event.type !== "crawl.failed") {
				return;
			}

			const row = storage.repos.crawlRuns.getById(crawlId);
			rowAtFailedEvent = row
				? { status: row.status, eventSequence: row.eventSequence }
				: null;
		});

		const runtime = new CrawlRuntime({
			crawlId,
			options: {
				...createOptions(),
				target: "https://fail.example",
			},
			logger: createLogger(),
			repos: storage.repos,
			eventStream,
			resolver,
			httpClient,
			resume: false,
			onSettled: () => {},
		});
		await runtime.start();
		unsubscribe();

		expect(
			rowAtFailedEvent as { status: string; eventSequence: number } | null,
		).toEqual({
			status: "failed",
			eventSequence: eventStream.getCurrentSequence(crawlId),
		});
	});

	test("item completion write failure does not persist uncommitted counters", async () => {
		const httpClient: HttpClient = {
			fetch: async () =>
				new Response(
					"<html><body><main>committed nowhere</main></body></html>",
					{
						status: 200,
						headers: { "content-type": "text/html" },
					},
				),
		};
		const { manager, storage, eventStream } = createManager(httpClient);
		storage.repos.crawlItems.commitCompletedItem = () => {
			throw new Error("item commit failed");
		};

		const created = manager.create(
			createOptions("https://commit-fail.example"),
		);
		let failedEventCounters: CrawlCounters | null = null;
		const unsubscribe = eventStream.subscribe(created.id, (event) => {
			if (event.type === "crawl.failed") {
				failedEventCounters = event.payload.counters;
			}
		});

		const failed = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "failed",
		);
		unsubscribe();

		expect(failed?.stopReason).toBe("item commit failed");
		expect(failed?.counters).toEqual(created.counters);
		expect(failedEventCounters as CrawlCounters | null).toEqual(
			failed?.counters ?? null,
		);
		expect(storage.repos.pages.listForExport(created.id)).toEqual([]);
		expect(storage.repos.crawlTerminals.listByCrawlId(created.id)).toEqual([]);
	});

	test("worker failure drains active workers before publishing failed terminal event", async () => {
		let secondWorkerStarted!: () => void;
		const secondWorkerStartedPromise = new Promise<void>((resolve) => {
			secondWorkerStarted = resolve;
		});
		const httpClient: HttpClient = {
			fetch: ({ url, signal }) => {
				if (url.endsWith("/a")) {
					return Promise.resolve(
						new Response("<html><body><main>a</main></body></html>", {
							status: 200,
							headers: { "content-type": "text/html" },
						}),
					);
				}
				if (url.endsWith("/b")) {
					secondWorkerStarted();
					return new Promise<Response>((resolve, reject) => {
						signal?.addEventListener(
							"abort",
							() =>
								reject(
									signal.reason instanceof Error
										? signal.reason
										: new Error("aborted"),
								),
							{ once: true },
						);
						setTimeout(
							() =>
								resolve(
									new Response("<html><body><main>b</main></body></html>", {
										status: 200,
										headers: { "content-type": "text/html" },
									}),
								),
							100,
						);
					});
				}
				return Promise.resolve(
					new Response(
						'<html><body><main>root</main><a href="/a">a</a><a href="/b">b</a></body></html>',
						{
							status: 200,
							headers: { "content-type": "text/html" },
						},
					),
				);
			},
		};
		const { manager, storage, eventStream } = createManager(httpClient);
		const originalCommit = storage.repos.crawlItems.commitCompletedItem.bind(
			storage.repos.crawlItems,
		);
		storage.repos.crawlItems.commitCompletedItem = (input) => {
			if (input.url.endsWith("/a")) {
				throw new Error("item commit failed");
			}
			return originalCommit(input);
		};

		const created = manager.create({
			...createOptions("https://parallel.example"),
			crawlDepth: 1,
			maxPages: 3,
			maxConcurrentRequests: 2,
		});
		const events: string[] = [];
		eventStream.subscribe(created.id, (event) => events.push(event.type));
		await secondWorkerStartedPromise;

		const failed = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "failed",
		);
		await Bun.sleep(150);

		const failedIndex = events.indexOf("crawl.failed");
		expect(failedIndex).toBeGreaterThanOrEqual(0);
		expect(events.slice(failedIndex + 1)).toEqual([]);
		expect(failed?.eventSequence).toBe(
			eventStream.getCurrentSequence(created.id),
		);
	});

	test("create -> pause -> paused", async () => {
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
		const { manager, storage, eventStream } = createManager(httpClient);
		const created = manager.create(createOptions("https://slow.example"));
		const events: string[] = [];
		type ObservedRunRow = {
			status: string;
			resumable: boolean;
			eventSequence: number;
		};
		let rowAtPausedEvent: ObservedRunRow | null = null;
		const unsubscribe = eventStream.subscribe(created.id, (event) => {
			events.push(event.type);
			if (event.type === "crawl.paused") {
				const row = storage.repos.crawlRuns.getById(created.id);
				rowAtPausedEvent = row
					? {
							status: row.status,
							resumable: row.resumable,
							eventSequence: row.eventSequence,
						}
					: null;
			}
		});

		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "running",
		);
		const pausePromise = manager.stop(created.id);
		releaseFetch();
		await pausePromise;

		const paused = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "paused",
		);

		expect(paused?.stopReason).toBe("Pause requested");
		expect(paused?.resumable).toBe(true);
		expect(events).toContain("crawl.paused");
		expect(rowAtPausedEvent as ObservedRunRow | null).toEqual({
			status: "paused",
			resumable: true,
			eventSequence: eventStream.getCurrentSequence(created.id),
		});
		expect(paused?.eventSequence).toBe(
			eventStream.getCurrentSequence(created.id),
		);
		unsubscribe();
	});

	test("paused event subscribers can resume because the runtime is already inactive", async () => {
		let releaseHome!: () => void;
		const httpClient: HttpClient = {
			fetch: async ({ url }) => {
				if (url.endsWith("/")) {
					return new Promise<Response>((resolve) => {
						releaseHome = () =>
							resolve(
								new Response(
									"<html><body><a href='https://pause-resume.example/about'>About</a><main>home</main></body></html>",
									{
										status: 200,
										headers: { "content-type": "text/html" },
									},
								),
							);
					});
				}

				return new Response("<html><body><main>about</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				});
			},
		};
		const { manager, storage, eventStream } = createManager(httpClient);
		const created = manager.create({
			...createOptions("https://pause-resume.example"),
			maxPages: 2,
		});
		let resumeType: ResumeCrawlResult["type"] | null = null;
		const unsubscribe = eventStream.subscribe(created.id, (event) => {
			if (event.type !== "crawl.paused" || resumeType !== null) {
				return;
			}

			resumeType = manager.resume(created.id).type;
		});

		await waitFor(
			() => typeof releaseHome,
			(value) => value === "function",
		);
		const pausePromise = manager.stop(created.id, "pause");
		releaseHome();
		await pausePromise;

		const observedResumeType = resumeType as ResumeCrawlResult["type"] | null;
		expect(observedResumeType).toBe("resumed");
		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);
		unsubscribe();
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
		expect(resumed.type).toBe("resumed");
		expect(["interrupted", "starting", "running"]).toContain(
			resumed.type === "resumed" ? resumed.crawl.status : "interrupted",
		);

		const completed = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed" && aboutResolved,
		);

		expect(completed?.counters.successCount).toBe(2);
	});

	test("shutdown cancels startup without waiting for hostname assertion", async () => {
		let resolverEntered = false;
		const resolver: Resolver = {
			assertPublicHostname: () => {
				resolverEntered = true;
				return new Promise<void>(() => {});
			},
			resolveHost: async () => ["93.184.216.34"],
		};
		const httpClient: HttpClient = {
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		};

		const { manager, storage, registry } = createManager(httpClient, resolver);
		const created = manager.create(createOptions("https://shutdown.example"));

		await waitFor(
			() => resolverEntered,
			(entered) => entered,
		);

		const shutdown = await Promise.race([
			manager.shutdownAll().then(() => "settled" as const),
			new Promise<"timeout">((resolve) =>
				setTimeout(() => resolve("timeout"), 100),
			),
		]);

		expect(shutdown).toBe("settled");
		expect(storage.repos.crawlRuns.getById(created.id)?.status).toBe(
			"interrupted",
		);
		expect(registry.size()).toBe(0);
	});

	test("shutdown aborts active work and keeps the active URL resumable", async () => {
		let holdAttempts = 0;
		let activeAbortObserved = false;
		const httpClient: HttpClient = {
			fetch: async ({ url, signal }) => {
				if (url.endsWith("/")) {
					return new Response(
						"<html><body><a href='https://example.com/hold'>Hold</a><main>home</main></body></html>",
						{
							status: 200,
							headers: { "content-type": "text/html" },
						},
					);
				}

				holdAttempts += 1;
				if (holdAttempts === 1) {
					return new Promise<Response>((_resolve, reject) => {
						signal?.addEventListener("abort", () => {
							activeAbortObserved = true;
							reject(signal.reason);
						});
					});
				}

				return new Response("<html><body><main>hold</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				});
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = manager.create({ ...createOptions(), maxPages: 2 });

		await waitFor(
			() => holdAttempts,
			(attempts) => attempts === 1,
		);
		await manager.shutdownAll();

		expect(activeAbortObserved).toBe(true);
		expect(storage.repos.crawlRuns.getById(created.id)?.status).toBe(
			"interrupted",
		);
		expect(storage.repos.crawlQueue.listPending(created.id)).toEqual([
			expect.objectContaining({ url: "https://example.com/hold" }),
		]);

		expect(manager.resume(created.id).type).toBe("resumed");
		const completed = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);

		expect(completed?.counters.successCount).toBe(2);
		expect(holdAttempts).toBe(2);
	});

	test("resume rejects active pausing crawls", () => {
		const httpClient: HttpClient = {
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		};
		const { manager, storage } = createManager(httpClient);
		const created = storage.repos.crawlRuns.createRun(
			"pausing-crawl",
			"https://example.com",
			createOptions(),
		);
		storage.repos.crawlRuns.markPausing(
			created.id,
			created.counters,
			"Pause requested",
			0,
		);

		const resumed = manager.resume(created.id);

		expect(resumed.type).toBe("not-resumable");
		expect(storage.repos.crawlRuns.getById(created.id)?.resumable).toBe(false);
	});

	test("resume rejects persisted rows with invalid crawl options before registering a runtime", () => {
		const httpClient: HttpClient = {
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		};
		const { manager, storage, registry } = createManager(httpClient);
		const created = storage.repos.crawlRuns.createRun(
			"invalid-options-crawl",
			"https://example.com",
			createOptions(),
		);
		storage.repos.crawlRuns.markPaused(
			created.id,
			created.counters,
			"Paused",
			0,
		);
		const invalidOptions = { ...createOptions() };
		delete (invalidOptions as Partial<typeof invalidOptions>)
			.maxConcurrentRequests;
		storage.db
			.query("UPDATE crawl_runs SET options_json = ? WHERE id = ?")
			.run(JSON.stringify(invalidOptions), created.id);

		const resumed = manager.resume(created.id);

		expect(resumed.type).toBe("not-resumable");
		expect(registry.get(created.id)).toBeUndefined();
		expect(storage.repos.crawlRuns.getById(created.id)?.status).toBe("paused");
	});

	test("resumable list excludes paused rows that still have a live runtime", () => {
		const httpClient: HttpClient = {
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		};
		const { manager, storage, registry } = createManager(httpClient);
		const settled = storage.repos.crawlRuns.createRun(
			"settled-paused-crawl",
			"https://settled.example",
			createOptions("https://settled.example"),
		);
		const active = storage.repos.crawlRuns.createRun(
			"active-paused-crawl",
			"https://active.example",
			createOptions("https://active.example"),
		);
		storage.repos.crawlRuns.markPaused(
			settled.id,
			settled.counters,
			"Paused",
			0,
		);
		storage.repos.crawlRuns.markPaused(
			active.id,
			active.counters,
			"Interrupted during shutdown",
			0,
		);
		registry.set(active.id, {} as CrawlRuntime);

		expect(manager.resume(active.id).type).toBe("already-running");
		expect(manager.listResumable().map((crawl) => crawl.id)).toEqual([
			settled.id,
		]);
	});

	test("stop returns the current snapshot for terminal crawls", async () => {
		const httpClient: HttpClient = {
			fetch: async () =>
				new Response("<html><body><main>done</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		};
		const { manager, storage } = createManager(httpClient);
		const created = manager.create(createOptions());

		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);

		const stopped = await manager.stop(created.id, "pause");

		expect(stopped.type).toBe("stopped");
		expect(stopped.type === "stopped" ? stopped.crawl.status : null).toBe(
			"completed",
		);
	});

	test("delete rejects persisted active rows even when no runtime is registered", () => {
		const httpClient: HttpClient = {
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		};
		const { manager, storage } = createManager(httpClient);
		const created = storage.repos.crawlRuns.createRun(
			"orphan-running-crawl",
			"https://example.com",
			createOptions(),
		);
		storage.repos.crawlRuns.markRunning(created.id, created.counters, 0);

		const deleted = manager.delete(created.id);

		expect(deleted.type).toBe("active");
		expect(storage.repos.crawlRuns.getById(created.id)?.status).toBe("running");
	});

	test("startup recovers registry-less active crawls as interrupted", () => {
		const storage = createInMemoryStorage();
		const eventStream = new EventStream();
		const registry = new RuntimeRegistry();
		const activeStatuses = [
			"starting",
			"running",
			"pausing",
			"stopping",
		] as const;
		const activeIds: string[] = [];
		for (const status of activeStatuses) {
			const active = storage.repos.crawlRuns.createRun(
				`orphan-${status}-crawl`,
				`https://${status}.example`,
				createOptions(`https://${status}.example`),
			);
			activeIds.push(active.id);
			if (status === "starting") {
				storage.repos.crawlRuns.markStarting(active.id, active.counters, 12);
			} else if (status === "running") {
				storage.repos.crawlRuns.markRunning(active.id, active.counters, 12);
			} else if (status === "pausing") {
				storage.repos.crawlRuns.markPausing(
					active.id,
					active.counters,
					"Pause requested",
					12,
				);
			} else {
				storage.repos.crawlRuns.markStopping(
					active.id,
					active.counters,
					"Stop requested",
					12,
				);
			}
		}

		const manager = new CrawlManager({
			logger: createLogger(),
			repos: storage.repos,
			eventStream,
			registry,
			resolver: {
				assertPublicHostname: async () => {},
				resolveHost: async () => ["93.184.216.34"],
			},
			httpClient: {
				fetch: async () =>
					new Response("<html><body><main>unused</main></body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		});

		for (const activeId of activeIds) {
			const recovered = storage.repos.crawlRuns.getById(activeId);
			expect(recovered?.status).toBe("interrupted");
			expect(recovered?.eventSequence).toBe(12);
		}
		expect(
			storage.repos.crawlRuns.getById("orphan-running-crawl")?.stopReason,
		).toBe("Runtime interrupted by process restart");
		expect(
			storage.repos.crawlRuns.getById("orphan-pausing-crawl")?.stopReason,
		).toBe("Pause requested");
		expect(
			manager
				.listResumable()
				.map((crawl) => crawl.id)
				.sort(),
		).toEqual(activeIds.sort());
		expect(manager.delete("orphan-running-crawl").type).toBe("deleted");
	});

	test("resume starts a fresh SSE replay window after the persisted event sequence", async () => {
		const httpClient: HttpClient = {
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		};
		const { manager, storage, eventStream } = createManager(httpClient);
		const crawlId = "crawl-stale-sse-resume";
		const counters = {
			pagesScanned: 0,
			successCount: 0,
			failureCount: 0,
			skippedCount: 0,
			linksFound: 0,
			mediaFiles: 0,
			totalDataKb: 0,
		};
		storage.repos.crawlRuns.createRun(crawlId, "https://resume.example", {
			...createOptions(),
			target: "https://resume.example",
		});
		const staleTerminal = eventStream.publish(crawlId, "crawl.paused", {
			stopReason: "Pause requested",
			counters,
		});
		storage.repos.crawlRuns.markPaused(
			crawlId,
			counters,
			"Pause requested",
			staleTerminal.sequence,
		);

		const result = manager.resume(crawlId);
		expect(result.type).toBe("resumed");
		const replayedEvents: Array<{ type: string; sequence: number }> = [];
		const unsubscribe = eventStream.subscribe(crawlId, (event) => {
			replayedEvents.push({ type: event.type, sequence: event.sequence });
		});

		await waitFor(
			() => storage.repos.crawlRuns.getById(crawlId),
			(run) => run?.status === "completed",
		);
		unsubscribe();

		expect(replayedEvents.some((event) => event.type === "crawl.paused")).toBe(
			false,
		);
		expect(
			replayedEvents.every((event) => event.sequence > staleTerminal.sequence),
		).toBe(true);
		expect(replayedEvents.map((event) => event.type)).toContain(
			"crawl.started",
		);
	});

	test("resume progress continues from the persisted crawl start time", async () => {
		const httpClient: HttpClient = {
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		};
		const { manager, storage, eventStream } = createManager(httpClient);
		const crawlId = "crawl-resume-elapsed";
		const created = storage.repos.crawlRuns.createRun(
			crawlId,
			"https://elapsed.example",
			createOptions("https://elapsed.example"),
		);
		storage.repos.crawlRuns.markPaused(
			crawlId,
			created.counters,
			"Pause requested",
			0,
		);
		storage.db
			.query(
				"UPDATE crawl_runs SET started_at = datetime('now', '-60 seconds') WHERE id = ?",
			)
			.run(crawlId);
		const elapsedSeconds: number[] = [];
		const unsubscribe = eventStream.subscribe(crawlId, (event) => {
			if (event.type === "crawl.progress") {
				elapsedSeconds.push(event.payload.elapsedSeconds);
			}
		});

		expect(manager.resume(crawlId).type).toBe("resumed");

		await waitFor(
			() => storage.repos.crawlRuns.getById(crawlId),
			(run) => run?.status === "completed",
		);
		unsubscribe();
		expect(elapsedSeconds.some((elapsed) => elapsed >= 60)).toBe(true);
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

		expect(manager.resume(created.id).type).toBe("resumed");
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
		expect(manager.resume(created.id).type).toBe("resumed");

		const completed = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);

		expect(completed?.counters.successCount).toBe(2);
		expect(rateAttempts).toBe(2);
	});

	test("configured concurrency launches multiple active workers without exceeding the limit", async () => {
		let activeChildren = 0;
		let maxActiveChildren = 0;
		let childStarts = 0;
		const releaseChildren: Array<() => void> = [];
		const httpClient: HttpClient = {
			fetch: async ({ url }) => {
				if (url.endsWith("/")) {
					return new Response(
						"<html><body><a href='https://example.com/a'>A</a><a href='https://example.com/b'>B</a><a href='https://example.com/c'>C</a><main>home</main></body></html>",
						{
							status: 200,
							headers: { "content-type": "text/html" },
						},
					);
				}

				childStarts += 1;
				activeChildren += 1;
				maxActiveChildren = Math.max(maxActiveChildren, activeChildren);
				return new Promise<Response>((resolve) => {
					releaseChildren.push(() => {
						activeChildren -= 1;
						resolve(
							new Response("<html><body><main>child</main></body></html>", {
								status: 200,
								headers: { "content-type": "text/html" },
							}),
						);
					});
				});
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = manager.create({
			...createOptions(),
			crawlDelay: 0,
			maxPages: 4,
			maxConcurrentRequests: 3,
		});

		await waitFor(
			() => childStarts,
			(starts) => starts === 3,
		);

		expect(maxActiveChildren).toBeGreaterThan(1);
		expect(maxActiveChildren).toBeLessThanOrEqual(3);
		for (const release of releaseChildren) release();

		const completed = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);
		expect(completed?.counters.successCount).toBe(4);
	});

	test("pause preserves pending queue and resume does not reprocess terminal URLs", async () => {
		const requests = new Map<string, number>();
		let releaseA!: () => void;
		const httpClient: HttpClient = {
			fetch: async ({ url }) => {
				requests.set(url, (requests.get(url) ?? 0) + 1);
				if (url.endsWith("/")) {
					return new Response(
						"<html><body><a href='https://example.com/a'>A</a><a href='https://example.com/b'>B</a><a href='https://example.com/c'>C</a><main>home</main></body></html>",
						{
							status: 200,
							headers: { "content-type": "text/html" },
						},
					);
				}

				if (url.endsWith("/a") && requests.get(url) === 1) {
					return new Promise<Response>((resolve) => {
						releaseA = () =>
							resolve(
								new Response("<html><body><main>a</main></body></html>", {
									status: 200,
									headers: { "content-type": "text/html" },
								}),
							);
					});
				}

				return new Response("<html><body><main>child</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				});
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = manager.create({
			...createOptions(),
			maxPages: 4,
			maxConcurrentRequests: 1,
		});

		await waitFor(
			() => typeof releaseA,
			(value) => value === "function",
		);
		const pausePromise = manager.stop(created.id, "pause");
		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "pausing",
		);
		expect(storage.repos.crawlQueue.listPending(created.id)).toHaveLength(3);
		releaseA();
		await pausePromise;

		const paused = storage.repos.crawlRuns.getById(created.id);
		expect(paused?.status).toBe("paused");
		expect(paused?.resumable).toBe(true);
		expect(storage.repos.crawlQueue.listPending(created.id)).toHaveLength(2);

		expect(manager.resume(created.id).type).toBe("resumed");
		const completed = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);

		expect(completed?.counters.successCount).toBe(4);
		expect(requests.get("https://example.com/")).toBe(1);
		expect(requests.get("https://example.com/a")).toBe(1);
	});

	test("pause preserves crawl-delay for links discovered after pause request", async () => {
		let releaseHome!: () => void;
		const httpClient: HttpClient = {
			fetch: async ({ url }) => {
				if (url.endsWith("/")) {
					return new Promise<Response>((resolve) => {
						releaseHome = () =>
							resolve(
								new Response(
									"<html><body><a href='https://example.com/child'>Child</a><main>home</main></body></html>",
									{
										status: 200,
										headers: { "content-type": "text/html" },
									},
								),
							);
					});
				}

				return new Response("<html><body><main>child</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				});
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = manager.create({
			...createOptions(),
			crawlDelay: 10_000,
			crawlDepth: 1,
			maxPages: 2,
		});

		await waitFor(
			() => typeof releaseHome,
			(value) => value === "function",
		);
		const pauseRequestedAt = Date.now();
		const pausePromise = manager.stop(created.id, "pause");
		releaseHome();
		await pausePromise;

		const pending = storage.repos.crawlQueue.listPending(created.id);
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({
			url: "https://example.com/child",
			domain: "example.com",
		});
		expect(pending[0]?.availableAt ?? 0).toBeGreaterThan(
			pauseRequestedAt + 1_000,
		);
	});

	test("force stop aborts active work, clears pending queue, and is terminal", async () => {
		let releaseAStarted = false;
		let activeAbortObserved = false;
		const httpClient: HttpClient = {
			fetch: async ({ url, signal }) => {
				if (url.endsWith("/")) {
					return new Response(
						"<html><body><a href='https://example.com/a'>A</a><a href='https://example.com/b'>B</a><main>home</main></body></html>",
						{
							status: 200,
							headers: { "content-type": "text/html" },
						},
					);
				}

				if (url.endsWith("/a")) {
					releaseAStarted = true;
					return new Promise<Response>((_resolve, reject) => {
						signal?.addEventListener("abort", () => {
							activeAbortObserved = true;
							reject(signal.reason);
						});
					});
				}

				return new Response("<html><body><main>b</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				});
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = manager.create({
			...createOptions(),
			maxPages: 3,
			maxConcurrentRequests: 1,
		});

		await waitFor(
			() => releaseAStarted,
			(started) => started,
		);
		const stopped = await manager.stop(created.id, "force");

		expect(activeAbortObserved).toBe(true);
		expect(stopped.type).toBe("stopped");
		expect(stopped.type === "stopped" ? stopped.crawl.status : null).toBe(
			"stopped",
		);
		expect(stopped.type === "stopped" ? stopped.crawl.resumable : true).toBe(
			false,
		);
		expect(storage.repos.crawlQueue.listPending(created.id)).toHaveLength(0);
		expect(storage.repos.pages.listForExport(created.id)).toHaveLength(1);
	});

	test("force stop cancels startup without waiting for hostname assertion", async () => {
		let resolverEntered = false;
		const resolver: Resolver = {
			assertPublicHostname: () => {
				resolverEntered = true;
				return new Promise<void>(() => {});
			},
			resolveHost: async () => ["93.184.216.34"],
		};
		const httpClient: HttpClient = {
			fetch: async () =>
				new Response("<html><body><main>unused</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		};

		const { manager, storage, registry } = createManager(httpClient, resolver);
		const created = manager.create(createOptions("https://startup.example"));

		await waitFor(
			() => resolverEntered,
			(entered) => entered,
		);

		const stopped = await Promise.race([
			manager.stop(created.id, "force"),
			new Promise<"timeout">((resolve) =>
				setTimeout(() => resolve("timeout"), 100),
			),
		]);

		expect(stopped).not.toBe("timeout");
		expect(
			stopped && typeof stopped === "object" && stopped.type === "stopped"
				? stopped.crawl.status
				: null,
		).toBe("stopped");
		expect(storage.repos.crawlRuns.getById(created.id)?.stopReason).toBe(
			"Force stop requested",
		);
		expect(registry.size()).toBe(0);
	});

	test("force stop after pause overrides the terminal stop reason", async () => {
		let activeAbortObserved = false;
		let activeStarted = false;
		const httpClient: HttpClient = {
			fetch: async ({ url, signal }) => {
				if (url.endsWith("/")) {
					return new Response(
						"<html><body><a href='https://example.com/a'>A</a><main>home</main></body></html>",
						{
							status: 200,
							headers: { "content-type": "text/html" },
						},
					);
				}

				activeStarted = true;
				return new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => {
						activeAbortObserved = true;
						reject(signal.reason);
					});
				});
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = manager.create({
			...createOptions(),
			maxPages: 2,
			maxConcurrentRequests: 1,
		});

		await waitFor(
			() => activeStarted,
			(started) => started,
		);
		const pausePromise = manager.stop(created.id, "pause");
		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "pausing",
		);

		const stopped = await manager.stop(created.id, "force");
		await pausePromise;

		expect(activeAbortObserved).toBe(true);
		expect(stopped.type).toBe("stopped");
		expect(stopped.type === "stopped" ? stopped.crawl.status : null).toBe(
			"stopped",
		);
		expect(stopped.type === "stopped" ? stopped.crawl.stopReason : null).toBe(
			"Force stop requested",
		);
		expect(storage.repos.crawlRuns.getById(created.id)?.stopReason).toBe(
			"Force stop requested",
		);
	});

	test("maxPages caps admitted URLs even when a page discovers more links", async () => {
		const httpClient: HttpClient = {
			fetch: async ({ url }) => {
				if (url.endsWith("/")) {
					return new Response(
						"<html><body><a href='https://example.com/a'>A</a><a href='https://example.com/b'>B</a><main>home</main></body></html>",
						{
							status: 200,
							headers: { "content-type": "text/html" },
						},
					);
				}

				return new Response("<html><body><main>child</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				});
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = manager.create({
			...createOptions(),
			maxPages: 1,
			maxConcurrentRequests: 3,
		});

		const completed = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);

		expect(completed?.counters.pagesScanned).toBe(1);
		expect(completed?.counters.successCount).toBe(1);
		expect(completed?.counters.skippedCount).toBe(0);
		expect(storage.repos.pages.listForExport(created.id)).toHaveLength(1);
	});

	test("stop requested during startup does not expose running state before stop is applied", async () => {
		const storage = createInMemoryStorage();
		const eventStream = new EventStream();
		const registry = new RuntimeRegistry();
		let releaseResolver!: () => void;
		const resolver: Resolver = {
			assertPublicHostname: async () => {
				await new Promise<void>((resolve) => {
					releaseResolver = resolve;
				});
			},
			resolveHost: async () => ["93.184.216.34"],
		};
		const httpClient: HttpClient = {
			fetch: async () =>
				new Response("<html><body><main>Hello</main></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		};
		const manager = new CrawlManager({
			logger: createLogger(),
			repos: storage.repos,
			eventStream,
			registry,
			resolver,
			httpClient,
		});

		const created = manager.create(createOptions());
		const observedStartupStatuses: string[] = [];
		const unsubscribe = eventStream.subscribe(created.id, (event) => {
			if (event.type === "crawl.started") {
				const row = storage.repos.crawlRuns.getById(created.id);
				if (row) {
					observedStartupStatuses.push(row.status);
				}
			}
		});
		const pausePromise = manager.stop(created.id, "pause");
		await Bun.sleep(0);
		releaseResolver();
		await pausePromise;

		const paused = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "paused",
		);
		expect(paused?.status).toBe("paused");
		expect(observedStartupStatuses).not.toContain("running");
		unsubscribe();
	});
});

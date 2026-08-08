import { describe, expect, mock, test } from "bun:test";
import type { CrawlCounters, CrawlOptions } from "../../../shared/contracts/index.js";
import {
	htmlDocumentResponse,
	htmlResponse,
	silentLogger,
	successfulHtmlHttpClient,
	waitFor,
} from "../../__tests__/runtimeFixture.js";
import { createInMemoryStorage } from "../../__tests__/storageFixture.js";
import { CRAWL_QUEUE_CONSTANTS } from "../../constants.js";
import { RobotsService } from "../../domain/crawl/RobotsService.js";
import type { HttpClient } from "../../outbound/HttpClient.js";
import {
	CrawlManager,
	CrawlRuntimeCapacityError,
	type ResumeCrawlResult,
} from "../CrawlManager.js";
import { CrawlRuntime } from "../CrawlRuntime.js";
import { EventStream } from "../EventStream.js";

function createRobotsService(httpClient: HttpClient): RobotsService {
	return new RobotsService(httpClient, silentLogger);
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
		target: new URL(target).toString(),
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

function createManager(
	httpClient: HttpClient = successfulHtmlHttpClient,
	storage = createInMemoryStorage(),
) {
	const eventStream = new EventStream();

	return {
		storage,
		eventStream,
		manager: new CrawlManager({
			logger: silentLogger,
			repos: storage.repos,
			eventStream,
			httpClient,
			storageBudget: storage.budget,
		}),
	};
}

function createCrawl(manager: CrawlManager, options: CrawlOptions) {
	return manager.create(crypto.randomUUID(), options);
}

describe("crawl manager contract", () => {
	test("create -> run -> complete", async () => {
		const { manager, storage, eventStream } = createManager();
		const created = createCrawl(manager, createOptions());

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
		expect(storage.repos.pages.listSnapshot(created.id).pages.map((page) => page.url)).toEqual([
			"https://example.com/",
		]);
		expect(storage.repos.crawlRuns.getById(created.id)?.eventSequence).toBe(
			eventStream.getCurrentSequence(created.id),
		);
	});

	test("shares one robots policy load across concurrent crawls", async () => {
		let robotsFetches = 0;
		let releaseRobots!: () => void;
		const robotsGate = new Promise<void>((resolve) => {
			releaseRobots = resolve;
		});
		const httpClient: HttpClient = {
			fetch: async ({ url }) => {
				if (url.endsWith("/robots.txt")) {
					robotsFetches += 1;
					await robotsGate;
					return new Response("User-agent: *\nAllow: /");
				}

				return htmlResponse("shared robots policy");
			},
		};
		const { manager, storage } = createManager(httpClient);
		const first = createCrawl(manager, {
			...createOptions("https://shared-policy.example/one"),
			respectRobots: true,
		});
		const second = createCrawl(manager, {
			...createOptions("https://shared-policy.example/two"),
			respectRobots: true,
		});

		await waitFor(
			() => robotsFetches,
			(count) => count > 0,
		);
		releaseRobots();
		await Promise.all([
			waitFor(
				() => storage.repos.crawlRuns.getById(first.id),
				(crawl) => crawl?.status === "completed",
			),
			waitFor(
				() => storage.repos.crawlRuns.getById(second.id),
				(crawl) => crawl?.status === "completed",
			),
		]);

		expect(robotsFetches).toBe(1);
	});

	test("enforces robots for an explicitly permitted localhost seed", async () => {
		const storage = createInMemoryStorage();
		const eventStream = new EventStream();
		const requests: Array<{ url: string; allowLocalhostOnInitialRequest?: boolean }> = [];
		const httpClient: HttpClient = {
			fetch: async (request) => {
				requests.push(request);
				if (request.url.endsWith("/robots.txt")) {
					return new Response("User-agent: *\nDisallow: /");
				}
				return htmlDocumentResponse("<html><main>must not be fetched</main></html>");
			},
		};
		const crawlId = "localhost-robots";
		const options = {
			...createOptions("http://localhost:3000/"),
			respectRobots: true,
		};
		storage.repos.crawlRuns.createRun(crawlId, options);
		const runtime = new CrawlRuntime({
			crawlId,
			options,
			logger: silentLogger,
			repos: storage.repos,
			storageBudget: storage.budget,
			eventStream,
			httpClient,
			robotsService: createRobotsService(httpClient),
			allowLocalhostSeed: true,
			resume: false,
			onSettled: () => {},
		});

		await runtime.start();

		expect(requests).toEqual([
			expect.objectContaining({
				url: "http://localhost:3000/robots.txt",
				allowLocalhostOnInitialRequest: true,
			}),
		]);
		expect(storage.repos.crawlRuns.getById(crawlId)?.counters.skippedCount).toBe(1);
	});

	test("create returns the current persisted startup snapshot", async () => {
		let releaseFetch!: () => void;
		const httpClient: HttpClient = {
			fetch: () =>
				new Promise<Response>((resolve) => {
					releaseFetch = () => resolve(htmlResponse("held"));
				}),
		};
		const { manager, storage } = createManager(httpClient);

		const created = createCrawl(manager, createOptions("https://startup.example"));
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

	test("event stream admission failure cannot create a client identity", async () => {
		const { manager, storage, eventStream } = createManager();
		const crawlId = "runtime-construction-retry";
		const options = createOptions("https://runtime-construction.example");
		const initialize = eventStream.initialize.bind(eventStream);
		const deleteStream = mock(eventStream.delete.bind(eventStream));
		eventStream.delete = deleteStream;
		eventStream.initialize = (id, sequence) => {
			initialize(id, sequence);
			throw new Error("runtime construction failed");
		};

		expect(() => manager.create(crawlId, options)).toThrow("runtime construction failed");
		expect(storage.repos.crawlRuns.getById(crawlId)).toBeNull();
		expect(storage.budget.usage().reservedBytes).toBe(0);
		expect(manager.activeRuntimeCount).toBe(0);
		expect(deleteStream).toHaveBeenCalledWith(crawlId);

		eventStream.initialize = initialize;
		const retried = manager.create(crawlId, options);
		expect(retried.id).toBe(crawlId);
		await waitFor(
			() => storage.repos.crawlRuns.getById(crawlId),
			(crawl) => crawl?.status === "completed",
		);
	});

	test("response read failure cannot roll back an established runtime", async () => {
		const { manager, storage } = createManager();
		const crawlId = "established-runtime-response-failure";
		const options = createOptions("https://established-runtime.example");
		const getById = storage.repos.crawlRuns.getById.bind(storage.repos.crawlRuns);
		storage.repos.crawlRuns.getById = (id) => {
			if (id === crawlId && manager.activeRuntimeCount > 0) throw new Error("response read failed");
			return getById(id);
		};

		expect(() => manager.create(crawlId, options)).toThrow("response read failed");
		storage.repos.crawlRuns.getById = getById;
		expect(getById(crawlId)?.id).toBe(crawlId);
		expect(manager.activeRuntimeCount).toBe(1);
		expect(manager.create(crawlId, options).id).toBe(crawlId);

		await waitFor(
			() => getById(crawlId),
			(crawl) => crawl?.status === "completed",
		);
	});

	test("reserves and releases the process-wide active runtime capacity", async () => {
		const httpClient: HttpClient = {
			fetch: ({ signal }) =>
				new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
						once: true,
					});
				}),
		};
		const { manager, storage } = createManager(httpClient);
		const activeIds = Array.from(
			{ length: CRAWL_QUEUE_CONSTANTS.MAX_ACTIVE_RUNTIMES },
			(_, index) => createCrawl(manager, createOptions(`https://capacity-${index}.example`)).id,
		);
		const rejectedId = crypto.randomUUID();

		expect(() =>
			manager.create(rejectedId, createOptions("https://capacity-rejected.example")),
		).toThrow(CrawlRuntimeCapacityError);
		expect(storage.repos.crawlRuns.getById(rejectedId)).toBeNull();

		await manager.stop(activeIds[0] ?? "", "force");
		manager.create(crypto.randomUUID(), createOptions("https://capacity-replacement.example"));
		expect(manager.activeRuntimeCount).toBe(CRAWL_QUEUE_CONSTANTS.MAX_ACTIVE_RUNTIMES);
		await manager.shutdownAll();
	});

	test("shrinks durable capacity reservations as terminal pages commit", async () => {
		const httpClient: HttpClient = {
			fetch: ({ url, signal }) => {
				if (url.endsWith("/next")) {
					return new Promise<Response>((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
							once: true,
						});
					});
				}
				return Promise.resolve(
					htmlDocumentResponse('<html><main>first</main><a href="/next">next</a></html>'),
				);
			},
		};
		const { manager, storage } = createManager(httpClient);
		const created = createCrawl(manager, {
			...createOptions("https://reservation.example"),
			crawlDepth: 1,
			maxPages: 2,
		});
		const initialReservation = storage.budget.usage().reservedBytes;

		await waitFor(
			() => storage.budget.usage().reservedBytes,
			(reservedBytes) => reservedBytes === initialReservation / 2,
		);
		expect(storage.repos.crawlRuns.getById(created.id)?.counters.pagesScanned).toBe(1);

		await manager.stop(created.id, "force");
		expect(storage.budget.usage().reservedBytes).toBe(0);
	});

	test("unexpected redirected processing failures retain the authorized destination domain", async () => {
		const storage = createInMemoryStorage();
		const httpClient: HttpClient = {
			fetch: async (request) => {
				await request.authorizeRedirect?.({
					fromUrl: request.url,
					toUrl: "https://final.example/page",
					statusCode: 302,
					hopNumber: 1,
				});
				storage.repos.crawlQueue.enqueueMany = () => {
					throw new Error("queue write failed");
				};
				return htmlDocumentResponse(
					'<html><main>redirected</main><a href="https://child.example/">child</a></html>',
				);
			},
		};
		const { eventStream, manager } = createManager(httpClient, storage);
		const crawlId = crypto.randomUUID();
		eventStream.initialize(crawlId);
		let terminalAtProgress: ReturnType<typeof storage.repos.crawlItems.listTerminalUrls> = [];
		const unsubscribe = eventStream.subscribe(crawlId, (event) => {
			if (event.type === "crawl.progress" && event.payload.counters.pagesScanned === 1) {
				terminalAtProgress = storage.repos.crawlItems.listTerminalUrls(crawlId);
			}
		});
		const created = manager.create(crawlId, {
			...createOptions("https://redirected.example"),
			crawlMethod: "full",
			maxPagesPerDomain: 1,
		});

		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(crawl) => crawl?.status === "completed",
		);
		unsubscribe();
		expect(terminalAtProgress).toEqual([
			{
				url: "https://redirected.example/",
				outcome: "failure",
				domainBudgetCharged: true,
				chargedDomain: "final.example",
			},
		]);
	});

	test("create and accepted resume retries preserve one caller-owned identity", async () => {
		let releaseFetch!: () => void;
		const httpClient: HttpClient = {
			fetch: () =>
				new Promise<Response>((resolve) => {
					releaseFetch = () => resolve(htmlResponse("held"));
				}),
		};
		const { manager, storage } = createManager(httpClient);
		const options = createOptions("https://idempotent.example");
		const crawlId = crypto.randomUUID();
		const created = manager.create(crawlId, options);
		const repeated = manager.create(crawlId, { ...options });
		expect(repeated.id).toBe(created.id);
		expect(storage.repos.crawlRuns.list()).toHaveLength(1);
		expect(() => manager.create(crawlId, { ...options, maxPages: options.maxPages + 1 })).toThrow(
			"already bound to different options",
		);

		await waitFor(
			() => typeof releaseFetch,
			(value) => value === "function",
		);
		releaseFetch();
		await waitFor(
			() => storage.repos.crawlRuns.getById(crawlId),
			(crawl) => crawl?.status === "completed",
		);

		const resumable = storage.repos.crawlRuns.createRun(
			"idempotent-resume",
			createOptions("https://resume-idempotent.example"),
		);
		storage.repos.crawlRuns.markPaused(resumable.id, "Paused", 0);
		expect(manager.resume(resumable.id).type).toBe("resumed");
		expect(manager.resume(resumable.id).type).toBe("already-active");
		await waitFor(
			() => storage.repos.crawlRuns.getById(resumable.id)?.status,
			(status) => status === "running",
		);
		releaseFetch();
		await waitFor(
			() => storage.repos.crawlRuns.getById(resumable.id)?.status,
			(status) => status === "completed",
		);
	});

	test("non-progress SSE events reserve their durable sequence before delivery", async () => {
		const httpClient: HttpClient = {
			fetch: async () => htmlResponse("Hello world"),
		};
		const storage = createInMemoryStorage();
		const eventStream = new EventStream();
		const crawlId = "crawl-seq-check";
		storage.repos.crawlRuns.createRun(crawlId, {
			...createOptions(),
			target: "https://sequence.example",
		});
		const observedSequences: Array<{ event: number; persisted: number }> = [];
		eventStream.initialize(crawlId);
		const unsubscribe = eventStream.subscribe(crawlId, (event) => {
			if (event.type === "crawl.started") {
				observedSequences.push({
					event: event.sequence,
					persisted: storage.repos.crawlRuns.getById(event.crawlId)?.eventSequence ?? -1,
				});
			}
		});

		const runtime = new CrawlRuntime({
			crawlId,
			options: {
				...createOptions(),
				target: "https://sequence.example",
			},
			logger: silentLogger,
			repos: storage.repos,
			storageBudget: storage.budget,
			eventStream,
			httpClient,
			robotsService: createRobotsService(httpClient),
			resume: false,
			onSettled: () => {},
		});
		await runtime.start();
		unsubscribe();

		const completed = await waitFor(
			() => storage.repos.crawlRuns.getById(crawlId),
			(run) => run?.status === "completed",
		);

		expect(observedSequences).toHaveLength(1);
		expect(observedSequences[0]?.persisted).toBeGreaterThanOrEqual(
			observedSequences[0]?.event ?? Number.MAX_SAFE_INTEGER,
		);
		expect(completed?.eventSequence).toBe(eventStream.getCurrentSequence(crawlId));
	});

	test("progress event subscribers observe the persisted event sequence", async () => {
		const httpClient: HttpClient = {
			fetch: async () => htmlResponse("Hello world"),
		};
		const { manager, storage, eventStream } = createManager(httpClient);
		const created = createCrawl(manager, createOptions("https://progress.example"));
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
				persistedSequence: storage.repos.crawlRuns.getById(created.id)?.eventSequence ?? -1,
			});
		});

		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);
		unsubscribe();

		expect(observedSequences.length).toBeGreaterThan(0);
		expect(
			observedSequences.every((sequence) => sequence.persistedSequence >= sequence.eventSequence),
		).toBe(true);
	});

	test("page events expose the identity and exact count from the committed page transaction", async () => {
		const httpClient: HttpClient = {
			fetch: async () => htmlResponse("Hello world"),
		};
		const { manager, storage, eventStream } = createManager(httpClient);
		const created = createCrawl(manager, createOptions("https://page-count.example"));
		const observedPages: Array<{
			eventId: number;
			durableId: number;
			eventCount: number;
			durableCount: number;
		}> = [];
		const unsubscribe = eventStream.subscribe(created.id, (event) => {
			if (event.type !== "crawl.page") return;
			const durableSnapshot = storage.repos.pages.listSnapshot(created.id);
			const durablePage = durableSnapshot.pages[0];
			if (!durablePage)
				throw new Error("Persisted page event was published before its durable row");
			observedPages.push({
				eventId: event.payload.id,
				durableId: durablePage.id,
				eventCount: event.payload.pageCount,
				durableCount: durableSnapshot.count,
			});
		});

		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);
		unsubscribe();

		expect(observedPages).toHaveLength(1);
		const observedPage = observedPages[0];
		if (!observedPage) throw new Error("Expected one persisted page event");
		expect(observedPage.eventId).toBeGreaterThan(0);
		expect(observedPage.eventId).toBe(observedPage.durableId);
		expect(observedPage.eventCount).toBe(observedPage.durableCount);
		expect(observedPage.eventCount).toBe(1);
	});

	test("completed event subscribers observe the terminal persisted status", async () => {
		const httpClient: HttpClient = {
			fetch: async () => htmlResponse("Hello world"),
		};
		const storage = createInMemoryStorage();
		const eventStream = new EventStream();
		const crawlId = "crawl-completed-order";
		storage.repos.crawlRuns.createRun(crawlId, {
			...createOptions(),
			target: "https://complete.example",
		});
		eventStream.initialize(crawlId);
		let rowAtCompletedEvent: { status: string; eventSequence: number } | null = null;
		const unsubscribe = eventStream.subscribe(crawlId, (event) => {
			if (event.type !== "crawl.completed") {
				return;
			}

			const row = storage.repos.crawlRuns.getById(crawlId);
			rowAtCompletedEvent = row ? { status: row.status, eventSequence: row.eventSequence } : null;
		});

		const runtime = new CrawlRuntime({
			crawlId,
			options: {
				...createOptions(),
				target: "https://complete.example",
			},
			logger: silentLogger,
			repos: storage.repos,
			storageBudget: storage.budget,
			eventStream,
			httpClient,
			robotsService: createRobotsService(httpClient),
			resume: false,
			onSettled: () => {},
		});
		await runtime.start();
		unsubscribe();

		expect(rowAtCompletedEvent as { status: string; eventSequence: number } | null).toEqual({
			status: "completed",
			eventSequence: eventStream.getCurrentSequence(crawlId),
		});
	});

	test("throwing completed event subscribers cannot change terminal crawl status", async () => {
		const httpClient: HttpClient = {
			fetch: async () => htmlResponse("Hello world"),
		};
		const storage = createInMemoryStorage();
		const eventStream = new EventStream();
		const crawlId = "crawl-throwing-completed-subscriber";
		storage.repos.crawlRuns.createRun(crawlId, {
			...createOptions(),
			target: "https://complete.example",
		});
		eventStream.initialize(crawlId);
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
			logger: silentLogger,
			repos: storage.repos,
			storageBudget: storage.budget,
			eventStream,
			httpClient,
			robotsService: createRobotsService(httpClient),
			resume: false,
			onSettled: () => {},
		});
		await runtime.start();
		unsubscribe();

		expect(storage.repos.crawlRuns.getById(crawlId)?.status).toBe("completed");
	});

	test("failed event subscribers observe the terminal persisted status", async () => {
		const httpClient: HttpClient = {
			fetch: async () => htmlResponse("unused"),
		};
		const storage = createInMemoryStorage();
		storage.repos.crawlItems.commitCompletedItem = () => {
			throw new Error("item commit failed");
		};
		const eventStream = new EventStream();
		const crawlId = "crawl-failed-order";
		storage.repos.crawlRuns.createRun(crawlId, {
			...createOptions(),
			target: "https://fail.example",
		});
		eventStream.initialize(crawlId);
		let rowAtFailedEvent: { status: string; eventSequence: number } | null = null;
		const unsubscribe = eventStream.subscribe(crawlId, (event) => {
			if (event.type !== "crawl.failed") {
				return;
			}

			const row = storage.repos.crawlRuns.getById(crawlId);
			rowAtFailedEvent = row ? { status: row.status, eventSequence: row.eventSequence } : null;
		});

		const runtime = new CrawlRuntime({
			crawlId,
			options: {
				...createOptions(),
				target: "https://fail.example",
			},
			logger: silentLogger,
			repos: storage.repos,
			storageBudget: storage.budget,
			eventStream,
			httpClient,
			robotsService: createRobotsService(httpClient),
			resume: false,
			onSettled: () => {},
		});
		await runtime.start();
		unsubscribe();

		expect(rowAtFailedEvent as { status: string; eventSequence: number } | null).toEqual({
			status: "failed",
			eventSequence: eventStream.getCurrentSequence(crawlId),
		});
	});

	test("manager quarantines terminal persistence failures without losing pending work", async () => {
		const storage = createInMemoryStorage();
		const commitCompletedItem = storage.repos.crawlItems.commitCompletedItem;
		const markFailed = storage.repos.crawlRuns.markFailed;
		storage.repos.crawlItems.commitCompletedItem = () => {
			throw new Error("item commit failed");
		};
		storage.repos.crawlRuns.markFailed = () => {
			throw new Error("terminal writer failed");
		};
		const { manager } = createManager(
			{
				fetch: async () => htmlDocumentResponse("<html><body><main>retry me</main></body></html>"),
			},
			storage,
		);
		const created = createCrawl(manager, createOptions("https://terminal-writer.example"));

		const interrupted = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(crawl) => crawl?.status === "interrupted",
		);
		expect(interrupted?.stopReason).toBe("Runtime settlement failed: terminal writer failed");
		expect(manager.activeRuntimeCount).toBe(0);
		expect(storage.repos.crawlQueue.listPending(created.id)).toHaveLength(1);

		storage.repos.crawlItems.commitCompletedItem = commitCompletedItem;
		storage.repos.crawlRuns.markFailed = markFailed;
		expect(manager.resume(created.id).type).toBe("resumed");
		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(crawl) => crawl?.status === "completed",
		);
	});

	test("manager retains ownership when settlement quarantine also fails", async () => {
		const storage = createInMemoryStorage();
		storage.repos.crawlItems.commitCompletedItem = () => {
			throw new Error("item commit failed");
		};
		storage.repos.crawlRuns.markFailed = () => {
			throw new Error("terminal writer failed");
		};
		const markInterrupted = mock(() => {
			throw new Error("quarantine writer failed");
		});
		storage.repos.crawlRuns.markInterrupted = markInterrupted;
		const { manager } = createManager(
			{
				fetch: async () => htmlDocumentResponse("<html><body><main>retry me</main></body></html>"),
			},
			storage,
		);
		const created = createCrawl(manager, createOptions("https://broken-quarantine.example"));

		await waitFor(
			() => markInterrupted.mock.calls.length,
			(callCount) => callCount === 1,
		);
		expect(manager.activeRuntimeCount).toBe(1);
		expect(storage.budget.usage().reservedBytes).toBeGreaterThan(0);
		expect(storage.repos.crawlQueue.listPending(created.id)).toHaveLength(1);
	});

	test("item completion write failure does not persist uncommitted counters", async () => {
		const httpClient: HttpClient = {
			fetch: async () => htmlResponse("committed nowhere"),
		};
		const { manager, storage, eventStream } = createManager(httpClient);
		storage.repos.crawlItems.commitCompletedItem = () => {
			throw new Error("item commit failed");
		};

		const created = createCrawl(manager, createOptions("https://commit-fail.example"));
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
		expect(failedEventCounters as CrawlCounters | null).toEqual(failed?.counters ?? null);
		expect(Array.from(storage.repos.pages.iterateForExport(created.id))).toEqual([]);
		expect(storage.repos.crawlItems.listTerminalUrls(created.id)).toEqual([]);
		expect(storage.repos.crawlQueue.listPending(created.id)).toEqual([]);
	});

	test("worker failure drains active workers before publishing failed terminal event", async () => {
		let secondWorkerStarted!: () => void;
		const secondWorkerStartedPromise = new Promise<void>((resolve) => {
			secondWorkerStarted = resolve;
		});
		const httpClient: HttpClient = {
			fetch: ({ url, signal }) => {
				if (url.endsWith("/a")) {
					return Promise.resolve(htmlResponse("a"));
				}
				if (url.endsWith("/b")) {
					secondWorkerStarted();
					return new Promise<Response>((resolve, reject) => {
						signal?.addEventListener(
							"abort",
							() => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
							{ once: true },
						);
						setTimeout(() => resolve(htmlResponse("b")), 100);
					});
				}
				return Promise.resolve(
					htmlDocumentResponse(
						'<html><body><main>root</main><a href="/a">a</a><a href="/b">b</a></body></html>',
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

		const created = createCrawl(manager, {
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
		expect(failed?.eventSequence).toBe(eventStream.getCurrentSequence(created.id));
		const durablePages = Array.from(storage.repos.pages.iterateForExport(created.id));
		const durableTerminals = storage.repos.crawlItems.listTerminalUrls(created.id);
		expect(durablePages.some((page) => page.url.endsWith("/a"))).toBe(false);
		expect(durableTerminals).toEqual([]);
		expect(failed?.counters.pagesScanned).toBe(
			(failed?.counters.successCount ?? 0) +
				(failed?.counters.failureCount ?? 0) +
				(failed?.counters.skippedCount ?? 0),
		);
		expect(failed?.counters.successCount).toBe(durablePages.length);
	});

	test("create -> pause -> paused", async () => {
		let releaseFetch!: () => void;
		const httpClient: HttpClient = {
			fetch: () =>
				new Promise<Response>((resolve) => {
					releaseFetch = () => resolve(htmlResponse("slow"));
				}),
		};
		const { manager, storage, eventStream } = createManager(httpClient);
		const created = createCrawl(manager, createOptions("https://slow.example"));
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
		expect(paused?.eventSequence).toBe(eventStream.getCurrentSequence(created.id));
		unsubscribe();
	});

	test("pause keeps an active transient failure retryable on resume", async () => {
		let attempts = 0;
		let releaseFirstAttempt!: () => void;
		const httpClient: HttpClient = {
			fetch: async () => {
				attempts += 1;
				if (attempts === 1) {
					return new Promise<Response>((resolve) => {
						releaseFirstAttempt = () =>
							resolve(new Response("retry", { status: 503, headers: { "retry-after": "0" } }));
					});
				}

				return htmlResponse("resumed");
			},
		};
		const { manager, storage } = createManager(httpClient);
		const created = createCrawl(manager, {
			...createOptions("https://pause-retry.example"),
			maxPages: 1,
			retryLimit: 1,
		});

		await waitFor(
			() => typeof releaseFirstAttempt,
			(value) => value === "function",
		);
		const pausePromise = manager.stop(created.id, "pause");
		releaseFirstAttempt();
		await pausePromise;

		expect(storage.repos.crawlRuns.getById(created.id)?.status).toBe("paused");
		expect(storage.repos.crawlQueue.listPending(created.id)).toMatchObject([{ retries: 1 }]);

		expect(manager.resume(created.id).type).toBe("resumed");
		const completed = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);
		expect(completed?.counters).toMatchObject({ successCount: 1, failureCount: 0 });
		expect(attempts).toBe(2);
	});

	test("paused event subscribers can resume because the runtime is already inactive", async () => {
		let releaseHome!: () => void;
		const httpClient: HttpClient = {
			fetch: async ({ url }) => {
				if (url.endsWith("/")) {
					return new Promise<Response>((resolve) => {
						releaseHome = () =>
							resolve(
								htmlDocumentResponse(
									"<html><body><a href='https://pause-resume.example/about'>About</a><main>home</main></body></html>",
								),
							);
					});
				}

				return htmlResponse("about");
			},
		};
		const { manager, storage, eventStream } = createManager(httpClient);
		const created = createCrawl(manager, {
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
					return htmlDocumentResponse(
						"<html><body><a href='https://example.com/about'>About</a><main>home</main></body></html>",
					);
				}

				if (aboutResolved) {
					return htmlResponse("about");
				}

				return new Promise<Response>((resolve) => {
					releaseAbout = () => {
						aboutResolved = true;
						resolve(htmlResponse("about"));
					};
				});
			},
		};

		const { manager, storage, eventStream } = createManager(httpClient);
		const created = createCrawl(manager, createOptions());
		const deliveredBeforeRestart: number[] = [];
		eventStream.subscribe(created.id, (event) => deliveredBeforeRestart.push(event.sequence));

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
		const durableSequenceBeforeRestart =
			storage.repos.crawlRuns.getById(created.id)?.eventSequence ?? 0;
		expect(deliveredBeforeRestart.length).toBeGreaterThan(0);
		expect(durableSequenceBeforeRestart).toBeGreaterThanOrEqual(
			Math.max(...deliveredBeforeRestart),
		);

		const restarted = createManager(httpClient, storage);
		const resumed = restarted.manager.resume(created.id);
		const deliveredAfterRestart: number[] = [];
		restarted.eventStream.subscribe(created.id, (event) =>
			deliveredAfterRestart.push(event.sequence),
		);
		expect(resumed.type).toBe("resumed");
		expect(["interrupted", "starting", "running"]).toContain(
			resumed.type === "resumed" ? resumed.crawl.status : "interrupted",
		);

		const completed = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed" && aboutResolved,
		);

		expect(completed?.counters.successCount).toBe(2);
		expect(deliveredAfterRestart.length).toBeGreaterThan(0);
		expect(Math.min(...deliveredAfterRestart)).toBeGreaterThan(durableSequenceBeforeRestart);
	});

	test("shutdown aborts the manager-owned robots policy load", async () => {
		let robotsEntered = false;
		let robotsAbortObserved = false;
		const httpClient: HttpClient = {
			fetch: ({ url, signal }) => {
				if (!url.endsWith("/robots.txt")) {
					return Promise.resolve(new Response("unused"));
				}

				robotsEntered = true;
				return new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener(
						"abort",
						() => {
							robotsAbortObserved = true;
							reject(signal.reason);
						},
						{ once: true },
					);
				});
			},
		};
		const { manager, storage } = createManager(httpClient);
		const created = createCrawl(manager, {
			...createOptions("https://shutdown-robots.example"),
			respectRobots: true,
		});

		await waitFor(
			() => robotsEntered,
			(entered) => entered,
		);
		const shutdown = await Promise.race([
			manager.shutdownAll().then(() => "settled" as const),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
		]);

		expect(shutdown).toBe("settled");
		expect(robotsAbortObserved).toBe(true);
		expect(storage.repos.crawlRuns.getById(created.id)?.status).toBe("interrupted");
		expect(manager.activeRuntimeCount).toBe(0);
	});

	test("shutdown aborts active work and keeps the active URL resumable", async () => {
		let holdAttempts = 0;
		let activeAbortObserved = false;
		const httpClient: HttpClient = {
			fetch: async ({ url, signal }) => {
				if (url.endsWith("/")) {
					return htmlDocumentResponse(
						"<html><body><a href='https://example.com/hold'>Hold</a><main>home</main></body></html>",
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

				return htmlResponse("hold");
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = createCrawl(manager, { ...createOptions(), maxPages: 2 });

		await waitFor(
			() => holdAttempts,
			(attempts) => attempts === 1,
		);
		await manager.shutdownAll();

		expect(activeAbortObserved).toBe(true);
		expect(storage.repos.crawlRuns.getById(created.id)?.status).toBe("interrupted");
		expect(storage.repos.crawlQueue.listPending(created.id)).toEqual([
			expect.objectContaining({ url: "https://example.com/hold" }),
		]);

		const restartedManager = createManager(httpClient, storage).manager;
		expect(restartedManager.resume(created.id).type).toBe("resumed");
		const completed = await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);

		expect(completed?.counters.successCount).toBe(2);
		expect(holdAttempts).toBe(2);
	});

	test("resume rejects active pausing crawls", () => {
		const httpClient: HttpClient = {
			fetch: async () => htmlResponse("unused"),
		};
		const { manager, storage } = createManager(httpClient);
		const created = storage.repos.crawlRuns.createRun("pausing-crawl", createOptions());
		storage.repos.crawlRuns.markPausing(created.id, "Pause requested", 0);

		const resumed = manager.resume(created.id);

		expect(resumed.type).toBe("not-resumable");
		expect(storage.repos.crawlRuns.getById(created.id)?.resumable).toBe(false);
	});

	test("resume rejects persisted rows with invalid crawl options before registering a runtime", () => {
		const httpClient: HttpClient = {
			fetch: async () => htmlResponse("unused"),
		};
		const { manager, storage } = createManager(httpClient);
		const created = storage.repos.crawlRuns.createRun("invalid-options-crawl", createOptions());
		storage.repos.crawlRuns.markPaused(created.id, "Paused", 0);
		const invalidOptions = { ...createOptions() };
		delete (invalidOptions as Partial<typeof invalidOptions>).maxConcurrentRequests;
		storage.db
			.query("UPDATE crawl_runs SET options_json = ? WHERE id = ?")
			.run(JSON.stringify(invalidOptions), created.id);

		expect(() => manager.resume(created.id)).toThrow(
			"contains options outside the current contract",
		);
		expect(manager.activeRuntimeCount).toBe(0);
		expect(
			(
				storage.db.query("SELECT status FROM crawl_runs WHERE id = ?").get(created.id) as {
					status: string;
				}
			).status,
		).toBe("paused");
	});

	test("stop returns the current snapshot for terminal crawls", async () => {
		const httpClient: HttpClient = {
			fetch: async () => htmlResponse("done"),
		};
		const { manager, storage } = createManager(httpClient);
		const created = createCrawl(manager, createOptions());

		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "completed",
		);

		const stopped = await manager.stop(created.id, "pause");

		expect(stopped.type).toBe("stopped");
		expect(stopped.type === "stopped" ? stopped.crawl.status : null).toBe("completed");
	});

	test("delete rejects persisted active rows even when no runtime is registered", () => {
		const httpClient: HttpClient = {
			fetch: async () => htmlResponse("unused"),
		};
		const { manager, storage } = createManager(httpClient);
		const created = storage.repos.crawlRuns.createRun("orphan-running-crawl", createOptions());
		storage.repos.crawlRuns.markRunning(created.id, 0);

		const deleted = manager.delete(created.id);

		expect(deleted.type).toBe("active");
		expect(storage.repos.crawlRuns.getById(created.id)?.status).toBe("running");
	});

	test("manager recovers persisted active crawls without live runtimes", () => {
		const storage = createInMemoryStorage();
		const eventStream = new EventStream();
		const activeStatuses = ["pending", "starting", "running", "pausing", "stopping"] as const;
		const activeIds: string[] = [];
		for (const status of activeStatuses) {
			const active = storage.repos.crawlRuns.createRun(
				`orphan-${status}-crawl`,
				createOptions(`https://${status}.example`),
			);
			activeIds.push(active.id);
			if (status === "pending") {
				// createRun owns the pending checkpoint and its initial queue seed.
			} else if (status === "starting") {
				storage.repos.crawlRuns.markStarting(active.id, 12);
			} else if (status === "running") {
				storage.repos.crawlRuns.markRunning(active.id, 12);
			} else if (status === "pausing") {
				storage.repos.crawlRuns.markPausing(active.id, "Pause requested", 12);
			} else {
				storage.repos.crawlRuns.markStopping(active.id, "Stop requested", 12);
			}
		}

		const manager = new CrawlManager({
			logger: silentLogger,
			repos: storage.repos,
			eventStream,
			httpClient: {
				fetch: async () => htmlResponse("unused"),
			},
			storageBudget: storage.budget,
		});

		for (const activeId of activeIds) {
			expect(storage.repos.crawlRuns.getById(activeId)?.status).not.toBe("interrupted");
		}

		manager.recoverOrphanedActiveCrawls();

		for (const activeId of activeIds) {
			const recovered = storage.repos.crawlRuns.getById(activeId);
			expect(recovered?.status).toBe(activeId.includes("stopping") ? "stopped" : "interrupted");
			expect(recovered?.eventSequence).toBe(activeId.includes("pending") ? 0 : 12);
		}
		expect(storage.repos.crawlRuns.getById("orphan-running-crawl")?.stopReason).toBe(
			"Runtime interrupted by process restart",
		);
		expect(storage.repos.crawlRuns.getById("orphan-pausing-crawl")?.stopReason).toBe(
			"Pause requested",
		);
		expect(storage.repos.crawlQueue.listPending("orphan-stopping-crawl")).toEqual([]);
		expect(
			manager
				.listResumable()
				.map((crawl) => crawl.id)
				.sort(),
		).toEqual(activeIds.filter((id) => !id.includes("stopping")).sort());
		expect(manager.delete("orphan-running-crawl").type).toBe("deleted");
	});

	test("resume constructor failure preserves resumable ownership and releases resources", () => {
		const httpClient: HttpClient = {
			fetch: async () => htmlResponse("unused"),
		};
		const { manager, storage } = createManager(httpClient);
		const crawl = storage.repos.crawlRuns.createRun(
			"resume-constructor-failure",
			createOptions("https://resume-constructor.example"),
		);
		storage.repos.crawlRuns.markPaused(crawl.id, "Paused", 3);
		storage.repos.crawlDomainState.listByCrawlId = () => [
			{
				delayKey: "https://resume-constructor.example",
				delayMs: Number.POSITIVE_INFINITY,
				nextAllowedAt: 0,
			},
		];

		expect(() => manager.resume(crawl.id)).toThrow("Domain delay must be finite");
		expect(manager.activeRuntimeCount).toBe(0);
		expect(storage.repos.crawlRuns.getById(crawl.id)?.status).toBe("paused");
		expect(storage.budget.usage().reservedBytes).toBe(0);
	});

	test("shutdown closes admission before taking the runtime snapshot", async () => {
		const httpClient: HttpClient = {
			fetch: async () => htmlResponse("unused"),
		};
		const { manager, storage } = createManager(httpClient);
		const paused = storage.repos.crawlRuns.createRun(
			"late-resume",
			createOptions("https://late-resume.example"),
		);
		storage.repos.crawlRuns.markPaused(paused.id, "Paused", 0);

		const shutdown = manager.shutdownAll();
		expect(() => createCrawl(manager, createOptions("https://late.example"))).toThrow(
			"Crawl service is shutting down",
		);
		expect(() => manager.resume(paused.id)).toThrow("Crawl service is shutting down");
		await shutdown;

		expect(manager.list({})).toEqual([
			expect.objectContaining({ id: paused.id, status: "paused" }),
		]);
		expect(manager.activeRuntimeCount).toBe(0);
		expect(
			(storage.db.query("SELECT COUNT(*) AS count FROM crawl_runs").get() as { count: number })
				.count,
		).toBe(1);
	});

	test("resume starts a fresh SSE replay window after the persisted event sequence", async () => {
		const httpClient: HttpClient = {
			fetch: async () => htmlResponse("unused"),
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
		storage.repos.crawlRuns.createRun(crawlId, {
			...createOptions(),
			target: "https://resume.example",
		});
		const staleTerminal = eventStream.publish(crawlId, "crawl.paused", {
			stopReason: "Pause requested",
			counters,
		});
		storage.repos.crawlRuns.markPaused(crawlId, "Pause requested", staleTerminal.sequence);

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

		expect(replayedEvents.some((event) => event.type === "crawl.paused")).toBe(false);
		expect(replayedEvents.every((event) => event.sequence > staleTerminal.sequence)).toBe(true);
		expect(replayedEvents.map((event) => event.type)).toContain("crawl.started");
	});

	test("resume progress continues from the persisted crawl start time", async () => {
		const httpClient: HttpClient = {
			fetch: async () => htmlResponse("unused"),
		};
		const { manager, storage, eventStream } = createManager(httpClient);
		const crawlId = "crawl-resume-elapsed";
		storage.repos.crawlRuns.createRun(crawlId, createOptions("https://elapsed.example"));
		storage.repos.crawlRuns.markPaused(crawlId, "Pause requested", 0);
		storage.db
			.query("UPDATE crawl_runs SET started_at = datetime('now', '-60 seconds') WHERE id = ?")
			.run(crawlId);
		const elapsedSeconds: number[] = [];

		expect(manager.resume(crawlId).type).toBe("resumed");
		const unsubscribe = eventStream.subscribe(crawlId, (event) => {
			if (event.type === "crawl.progress") {
				elapsedSeconds.push(event.payload.queue.elapsedTime);
			}
		});

		await waitFor(
			() => storage.repos.crawlRuns.getById(crawlId),
			(run) => run?.status === "completed",
		);
		unsubscribe();
		expect(elapsedSeconds.some((elapsed) => elapsed >= 59)).toBe(true);
	});

	test("resume does not reprocess previously failed URLs", async () => {
		let holdResolved = false;
		let releaseHold!: () => void;
		let badRequests = 0;
		const httpClient: HttpClient = {
			fetch: async ({ url }) => {
				if (url.endsWith("/")) {
					return htmlDocumentResponse(
						"<html><body><a href='https://example.com/bad'>Bad</a><a href='https://example.com/hold'>Hold</a><main>home</main></body></html>",
					);
				}

				if (url.endsWith("/bad")) {
					badRequests += 1;
					return new Response("bad", { status: 500 });
				}

				if (holdResolved) {
					return htmlDocumentResponse(
						"<html><body><a href='https://example.com/bad'>Bad</a><main>hold</main></body></html>",
					);
				}

				return new Promise<Response>((resolve) => {
					releaseHold = () => {
						holdResolved = true;
						resolve(
							htmlDocumentResponse(
								"<html><body><a href='https://example.com/bad'>Bad</a><main>hold</main></body></html>",
							),
						);
					};
				});
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = createCrawl(manager, { ...createOptions(), maxPages: 5 });

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

		const restartedManager = createManager(httpClient, storage).manager;
		expect(restartedManager.resume(created.id).type).toBe("resumed");
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
					return htmlDocumentResponse(
						"<html><body><a href='https://example.com/rate'>Rate</a><main>home</main></body></html>",
					);
				}

				rateAttempts += 1;
				if (rateAttempts === 1) {
					return new Response("", {
						status: 429,
						headers: { "retry-after": "1" },
					});
				}

				return htmlResponse("rate");
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = createCrawl(manager, {
			...createOptions(),
			maxPages: 5,
			retryLimit: 1,
		});

		await waitFor(
			() => storage.repos.crawlQueue.listPending(created.id),
			(items) => items.some((item) => item.url.endsWith("/rate") && item.retries === 1),
		);

		await manager.shutdownAll();
		await waitFor(
			() => storage.repos.crawlRuns.getById(created.id),
			(run) => run?.status === "interrupted",
		);

		await Bun.sleep(1_050);
		const restartedManager = createManager(httpClient, storage).manager;
		expect(restartedManager.resume(created.id).type).toBe("resumed");

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
				if (url === "https://example.com/") {
					return htmlDocumentResponse(
						"<html><body><a href='https://a.example/page'>A</a><a href='https://b.example/page'>B</a><a href='https://c.example/page'>C</a><main>home</main></body></html>",
					);
				}

				childStarts += 1;
				activeChildren += 1;
				maxActiveChildren = Math.max(maxActiveChildren, activeChildren);
				return new Promise<Response>((resolve) => {
					releaseChildren.push(() => {
						activeChildren -= 1;
						resolve(htmlResponse("child"));
					});
				});
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = createCrawl(manager, {
			...createOptions(),
			crawlMethod: "full",
			crawlDelay: 200,
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
					return htmlDocumentResponse(
						"<html><body><a href='https://example.com/a'>A</a><a href='https://example.com/b'>B</a><a href='https://example.com/c'>C</a><main>home</main></body></html>",
					);
				}

				if (url.endsWith("/a") && requests.get(url) === 1) {
					return new Promise<Response>((resolve) => {
						releaseA = () => resolve(htmlResponse("a"));
					});
				}

				return htmlResponse("child");
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = createCrawl(manager, {
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
								htmlDocumentResponse(
									"<html><body><a href='https://example.com/child'>Child</a><main>home</main></body></html>",
								),
							);
					});
				}

				return htmlResponse("child");
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = createCrawl(manager, {
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
		expect(pending[0]?.availableAt ?? 0).toBeGreaterThan(pauseRequestedAt + 1_000);
	});

	test("force stop aborts active work, clears pending queue, and is terminal", async () => {
		let releaseAStarted = false;
		let activeAbortObserved = false;
		const httpClient: HttpClient = {
			fetch: async ({ url, signal }) => {
				if (url.endsWith("/")) {
					return htmlDocumentResponse(
						"<html><body><a href='https://example.com/a'>A</a><a href='https://example.com/b'>B</a><main>home</main></body></html>",
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

				return htmlResponse("b");
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = createCrawl(manager, {
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
		expect(stopped.type === "stopped" ? stopped.crawl.status : null).toBe("stopped");
		expect(stopped.type === "stopped" ? stopped.crawl.resumable : true).toBe(false);
		expect(storage.repos.crawlQueue.listPending(created.id)).toHaveLength(0);
		expect(Array.from(storage.repos.pages.iterateForExport(created.id))).toHaveLength(1);
	});

	test("force stop after pause overrides the terminal stop reason", async () => {
		let activeAbortObserved = false;
		let activeStarted = false;
		const httpClient: HttpClient = {
			fetch: async ({ url, signal }) => {
				if (url.endsWith("/")) {
					return htmlDocumentResponse(
						"<html><body><a href='https://example.com/a'>A</a><main>home</main></body></html>",
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
		const created = createCrawl(manager, {
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
		expect(stopped.type === "stopped" ? stopped.crawl.status : null).toBe("stopped");
		expect(stopped.type === "stopped" ? stopped.crawl.stopReason : null).toBe(
			"Force stop requested",
		);
		expect(storage.repos.crawlRuns.getById(created.id)?.stopReason).toBe("Force stop requested");
	});

	test("maxPages caps admitted URLs even when a page discovers more links", async () => {
		const httpClient: HttpClient = {
			fetch: async ({ url }) => {
				if (url.endsWith("/")) {
					return htmlDocumentResponse(
						"<html><body><a href='https://example.com/a'>A</a><a href='https://example.com/b'>B</a><main>home</main></body></html>",
					);
				}

				return htmlResponse("child");
			},
		};

		const { manager, storage } = createManager(httpClient);
		const created = createCrawl(manager, {
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
		expect(Array.from(storage.repos.pages.iterateForExport(created.id))).toHaveLength(1);
	});
});

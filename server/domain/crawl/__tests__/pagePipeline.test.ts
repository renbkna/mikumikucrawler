import { describe, expect, mock, test } from "bun:test";
import type { CrawlOptions } from "../../../../shared/contracts/index.js";
import { silentLogger } from "../../../__tests__/runtimeFixture.js";
import type { Logger } from "../../../config/logging.js";
import type { RobotsPolicyEvaluator } from "../CrawlAdmissionPolicy.js";
import type { DestinationAuthorizer } from "../FetchService.js";
import { PagePipeline } from "../PagePipeline.js";

type PagePipelineState = ConstructorParameters<typeof PagePipeline>[1];
type PagePipelineQueue = ConstructorParameters<typeof PagePipeline>[2];
type PageFetcher = ConstructorParameters<typeof PagePipeline>[3];

const defaultOptions: CrawlOptions = {
	target: "https://example.com/",
	crawlMethod: "links",
	crawlDepth: 1,
	crawlDelay: 200,
	maxPages: 10,
	maxPagesPerDomain: 0,
	maxConcurrentRequests: 1,
	retryLimit: 0,
	dynamic: false,
	respectRobots: false,
	contentOnly: false,
	saveMedia: false,
};

const defaultState: PagePipelineState = {
	adaptDomainDelay: () => undefined,
	hasPageCapacity: () => true,
	hasVisited: () => false,
	isDomainBudgetExceeded: () => false,
	remainingAdmissionCapacity: () => 10,
	reserveDomain: () => undefined,
	setDomainDelay: () => undefined,
	timeUntilDomainReady: () => 0,
	tryReserveRedirectDomain: () => true,
};

const defaultQueue: PagePipelineQueue = {
	enqueueNormalized: () => true,
	scheduleRetry: () => undefined,
};

const defaultRobots: RobotsPolicyEvaluator = {
	evaluateIdentity: async (identity) => ({
		type: "allowed",
		delayKey: identity.domainBudgetKey,
	}),
};

function createPipeline(
	options: Partial<CrawlOptions>,
	state: Partial<PagePipelineState>,
	queue: Partial<PagePipelineQueue>,
	fetchService: PageFetcher,
	robotsService: Partial<RobotsPolicyEvaluator>,
	eventSink: { log(message: string): void },
	logger: Logger = silentLogger,
	localSeedUrl?: string,
	itemTimeoutMs?: number,
): PagePipeline {
	return new PagePipeline(
		{ ...defaultOptions, ...options },
		{ ...defaultState, ...state },
		{ ...defaultQueue, ...queue },
		fetchService,
		{ ...defaultRobots, ...robotsService },
		eventSink,
		logger,
		localSeedUrl,
		itemTimeoutMs,
	);
}

describe("page pipeline contract", () => {
	test("records unsupported response types as skipped pages", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const pipeline = createPipeline(
			{},
			{},
			{},
			{
				fetch: async () => ({
					type: "unsupported",
					statusCode: 200,
					contentType: "application/x-apple-diskimage",
				}),
			},
			{},
			eventSink,
		);

		const result = await pipeline.process({
			url: "https://example.com/download",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toMatchObject({ terminalOutcome: "skip" });
		expect(eventSink.log).toHaveBeenCalledWith(
			"[Crawler] Unsupported content type application/x-apple-diskimage: https://example.com/download",
		);
	});

	test("surfaces blocked fetch reasons to the event sink", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const state = {
			adaptDomainDelay: mock(() => undefined),
		};
		const pipeline = createPipeline(
			{},
			state,
			{},
			{
				fetch: async () => ({
					type: "blocked",
					statusCode: 403,
					reason: "Consent wall could not be bypassed for https://www.youtube.com/watch?v=test",
				}),
			},
			{},
			eventSink,
		);

		const result = await pipeline.process({
			url: "https://www.youtube.com/watch?v=test",
			domain: "www.youtube.com",
			depth: 0,
			retries: 0,
		});

		expect(state.adaptDomainDelay).toHaveBeenCalledWith("www.youtube.com", 403);
		expect(result).toMatchObject({
			terminalOutcome: "failure",
			terminalEffects: { chargeDomainBudget: true },
		});
		expect(eventSink.log).toHaveBeenCalledWith(
			"[Crawler] Consent wall could not be bypassed for https://www.youtube.com/watch?v=test",
		);
	});

	test("records a skipped terminal outcome when max pages has already been reached", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const pipeline = createPipeline(
			{},
			{
				hasPageCapacity: () => false,
			},
			{},
			{
				fetch: mock(async () => {
					throw new Error("fetch should not be called");
				}),
			},
			{},
			eventSink,
		);

		const result = await pipeline.process({
			url: "https://example.com/overflow",
			domain: "example.com",
			depth: 1,
			retries: 0,
		});

		expect(result).toEqual({
			terminalOutcome: "skip",
			terminalEffects: { chargeDomainBudget: false },
		});
		expect(eventSink.log).toHaveBeenCalledWith(
			"[Limit] Max pages reached: https://example.com/overflow",
		);
	});

	test("contains restored work beyond the domain budget as an observable uncharged skip", async () => {
		const eventSink = { log: mock(() => undefined) };
		const fetch = mock(async () => {
			throw new Error("fetch should not be called");
		});
		const pipeline = createPipeline(
			{},
			{
				isDomainBudgetExceeded: () => true,
			},
			{},
			{ fetch },
			{},
			eventSink,
		);
		const item = {
			url: "https://example.com/restored-excess",
			domain: "example.com",
			depth: 1,
			retries: 0,
		};

		await expect(pipeline.process(item)).resolves.toEqual({
			terminalOutcome: "skip",
			terminalEffects: { chargeDomainBudget: false },
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(eventSink.log).toHaveBeenCalledWith(
			"[Budget] Domain budget exceeded: https://example.com/restored-excess",
		);
	});

	test("rejects a terminal URL that re-enters the runtime queue", async () => {
		const fetch = mock(async () => {
			throw new Error("fetch should not be called");
		});
		const pipeline = createPipeline(
			{},
			{
				hasVisited: () => true,
			},
			{},
			{ fetch },
			{},
			{ log: mock(() => undefined) },
		);
		const item = {
			url: "https://example.com/already-terminal",
			domain: "example.com",
			depth: 0,
			retries: 0,
		};

		await expect(pipeline.process(item)).rejects.toThrow(
			"Queued URL is already terminal: https://example.com/already-terminal",
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("XHTML responses admit discovered links through the HTML pipeline", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const enqueueNormalized = mock(() => true);
		const pipeline = createPipeline(
			{},
			{},
			{
				enqueueNormalized,
			},
			{
				fetch: async () => ({
					type: "success",
					content: '<html><body><main>XHTML</main><a href="/next">Next</a></body></html>',
					effectiveUrl: "https://example.com/page",
					statusCode: 200,
					contentType: "application/xhtml+xml; charset=utf-8",
					contentLength: 75,
					title: "",
					description: "",
					xRobotsTag: null,
				}),
			},
			{},
			eventSink,
		);

		const result = await pipeline.process({
			url: "https://example.com/page",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(enqueueNormalized).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.com/next",
				domain: "example.com",
				depth: 1,
			}),
		);
		expect(result).toMatchObject({
			terminalOutcome: "success",
			terminalEffects: { chargeDomainBudget: true },
		});
	});

	test("aborted processing rejects before returning a late success", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const controller = new AbortController();
		const pipeline = createPipeline(
			{},
			{},
			{},
			{
				fetch: async (_item: unknown, signal?: AbortSignal) => {
					expect(signal).toBeDefined();
					controller.abort(new Error("timeout"));
					expect(signal?.aborted).toBe(true);
					return {
						type: "success",
						content: "<html><body><main>late</main></body></html>",
						effectiveUrl: "https://example.com/late",
						statusCode: 200,
						contentType: "text/html",
						contentLength: 44,
						title: "",
						description: "",
						xRobotsTag: null,
					} as const;
				},
			},
			{},
			eventSink,
		);

		await expect(
			pipeline.process(
				{
					url: "https://example.com/late",
					domain: "example.com",
					depth: 0,
					retries: 0,
				},
				controller.signal,
			),
		).rejects.toThrow("timeout");
	});

	test("persists a substantial 404 error-handling guide as ordinary content", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const content = `<html><head><title>404 Error Handling Guide</title></head><body><main>${"Substantial error-handling guidance. ".repeat(120)}</main></body></html>`;
		const pipeline = createPipeline(
			{},
			{},
			{},
			{
				fetch: async () => ({
					type: "success",
					content,
					effectiveUrl: "https://example.com/",
					statusCode: 200,
					contentType: "text/html",
					contentLength: Buffer.byteLength(content),
					title: "",
					description: "",
					xRobotsTag: null,
				}),
			},
			{},
			eventSink,
		);

		const result = await pipeline.process({
			url: "https://example.com/",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result.page?.eventPayload.url).toBe("https://example.com/");
		expect(result.page?.eventPayload).not.toHaveProperty("id");
		expect(result).toMatchObject({
			terminalOutcome: "success",
			terminalEffects: { chargeDomainBudget: true },
		});
		expect(eventSink.log).toHaveBeenCalledWith("[Crawler] Crawled https://example.com/");
	});

	test("rendered client error shells return terminal failure without page data", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const pipeline = createPipeline(
			{},
			{},
			{},
			{
				fetch: async () => ({
					type: "success",
					content:
						"<html><body><main>Oops! Something went wrong Miku encountered an unexpected error Try Again Reload Page</main></body></html>",
					effectiveUrl: "https://example.com/crashed-app",
					statusCode: 200,
					contentType: "text/html",
					contentLength: 270_622,
					title: "",
					description: "",
					xRobotsTag: null,
				}),
			},
			{},
			eventSink,
		);

		const result = await pipeline.process({
			url: "https://example.com/crashed-app",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toEqual({
			terminalOutcome: "failure",
			terminalEffects: { chargeDomainBudget: true },
		});
		expect(result.page).toBeUndefined();
		expect(eventSink.log).toHaveBeenCalledWith(
			"[Crawler] Client error shell detected: https://example.com/crashed-app",
		);
	});

	test("noindex terminal pages count against the domain budget", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const pipeline = createPipeline(
			{},
			{},
			{},
			{
				fetch: async () => ({
					type: "success",
					content:
						'<html><head><meta name="robots" content="noindex"></head><body><main>Do not index this page.</main><a href="/next">next</a></body></html>',
					effectiveUrl: "https://example.com/noindex",
					statusCode: 200,
					contentType: "text/html",
					contentLength: 1200,
					title: "",
					description: "",
					xRobotsTag: null,
				}),
			},
			{},
			eventSink,
		);

		const result = await pipeline.process({
			url: "https://example.com/noindex",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toEqual({
			terminalOutcome: "skip",
			terminalEffects: { chargeDomainBudget: true },
		});
	});

	test("abort during noindex link admission rejects before terminal classification", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const controller = new AbortController();
		const pipeline = createPipeline(
			{
				target: "https://example.com",
				respectRobots: true,
			},
			{},
			{},
			{
				fetch: async () => ({
					type: "success",
					content:
						'<html><head><meta name="robots" content="noindex"></head><body><main>Do not index this page.</main><a href="/next">next</a></body></html>',
					effectiveUrl: "https://example.com/noindex",
					statusCode: 200,
					contentType: "text/html",
					contentLength: 1200,
					title: "",
					description: "",
					xRobotsTag: null,
				}),
			},
			{
				evaluateIdentity: mock(async () => {
					controller.abort(new Error("force stop"));
					throw new Error("force stop");
				}),
			},
			eventSink,
		);

		await expect(
			pipeline.process(
				{
					url: "https://example.com/noindex",
					domain: "example.com",
					depth: 0,
					retries: 0,
				},
				controller.signal,
			),
		).rejects.toThrow("force stop");
	});

	test("saveMedia=false strips extracted media from returned page data", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const pipeline = createPipeline(
			{
				crawlMethod: "media",
			},
			{},
			{},
			{
				fetch: async () => ({
					type: "success",
					content:
						'<html><body><main>This is a long enough article body to exercise page-result construction during the contract test execution path.</main><img src="/image.png" alt="cover" /></body></html>',
					effectiveUrl: "https://example.com/post",
					statusCode: 200,
					contentType: "text/html",
					contentLength: 4000,
					title: "",
					description: "",
					xRobotsTag: null,
				}),
			},
			{},
			eventSink,
		);

		const result = await pipeline.process({
			url: "https://example.com/post",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result.page?.pageData.mediaCount).toBe(0);
		expect(result).toMatchObject({
			terminalOutcome: "success",
			terminalEffects: { chargeDomainBudget: true },
		});
	});

	test("media mode with saveMedia=true counts extracted media", async () => {
		const eventSink = {
			log: mock(() => undefined),
		};
		const pipeline = createPipeline(
			{
				saveMedia: true,
				crawlMethod: "media",
			},
			{},
			{},
			{
				fetch: async () => ({
					type: "success",
					content:
						'<html><body><main>This is a long enough article body to exercise page-result construction during the contract test execution path.</main><img src="/image.png" alt="cover" /></body></html>',
					effectiveUrl: "https://example.com/post",
					statusCode: 200,
					contentType: "text/html",
					contentLength: 4000,
					title: "",
					description: "",
					xRobotsTag: null,
				}),
			},
			{},
			eventSink,
		);

		const result = await pipeline.process({
			url: "https://example.com/post",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result.page?.pageData.mediaCount).toBe(1);
		expect(result).toMatchObject({
			terminalOutcome: "success",
			terminalEffects: { chargeDomainBudget: true },
		});
	});

	test("preserves retryable active work after a graceful pause request", async () => {
		const scheduleRetry = mock(() => undefined);
		const item = {
			url: "https://example.com/",
			domain: "example.com",
			depth: 0,
			retries: 0,
		};
		const pipeline = createPipeline(
			{
				retryLimit: 1,
			},
			{},
			{
				scheduleRetry,
			},
			{
				fetch: async () => ({
					type: "transientFailure",
					statusCode: 500,
				}),
			},
			{},
			{ log: mock(() => undefined) },
		);

		await expect(pipeline.process(item)).resolves.toEqual({
			rescheduled: true,
		});
		expect(scheduleRetry).toHaveBeenCalledWith(item, 1000);
	});

	test("owns retry fallback timing for rate limits without retry-after", async () => {
		const scheduleRetry = mock(() => undefined);
		const adaptDomainDelay = mock(() => undefined);
		const item = {
			url: "https://example.com/",
			domain: "example.com",
			depth: 0,
			retries: 1,
		};
		const pipeline = createPipeline(
			{
				retryLimit: 2,
			},
			{
				adaptDomainDelay,
			},
			{
				scheduleRetry,
			},
			{
				fetch: async () => ({
					type: "rateLimited",
					statusCode: 429,
				}),
			},
			{},
			{ log: mock(() => undefined) },
		);

		await expect(pipeline.process(item)).resolves.toEqual({
			rescheduled: true,
		});
		expect(scheduleRetry).toHaveBeenCalledWith(item, 2000);
		expect(adaptDomainDelay).toHaveBeenCalledWith("example.com", 429, 2000);
	});

	test("waits for timed-out attempt cleanup before handing work to the retry owner", async () => {
		const scheduleRetry = mock(() => undefined);
		let attemptSignal: AbortSignal | undefined;
		const attemptAborted = Promise.withResolvers<void>();
		const releaseCleanup = Promise.withResolvers<void>();
		const item = {
			url: "https://example.com/stalled",
			domain: "example.com",
			depth: 0,
			retries: 1,
		};
		const pipeline = createPipeline(
			{
				retryLimit: 2,
			},
			{},
			{ scheduleRetry },
			{
				fetch: async (_item: unknown, signal: AbortSignal) => {
					attemptSignal = signal;
					await new Promise<void>((resolve) => {
						signal.addEventListener("abort", () => resolve(), { once: true });
					});
					attemptAborted.resolve();
					await releaseCleanup.promise;
					signal.throwIfAborted();
					throw new Error("unreachable");
				},
			},
			{},
			{ log: mock(() => undefined) },
			silentLogger,
			undefined,
			5,
		);

		const processing = pipeline.process(item);
		await attemptAborted.promise;
		expect(scheduleRetry).not.toHaveBeenCalled();
		releaseCleanup.resolve();
		await expect(processing).resolves.toEqual({ rescheduled: true });
		expect(attemptSignal?.aborted).toBe(true);
		expect(scheduleRetry).toHaveBeenCalledWith(item, 2000);
	});

	test("classifies redirected links against the effective document while preserving requested identity", async () => {
		const enqueueNormalized = mock(() => true);
		const pipeline = createPipeline(
			{
				crawlMethod: "full",
			},
			{
				tryReserveRedirectDomain: mock(() => true),
				reserveDomain: mock(() => undefined),
			},
			{
				enqueueNormalized,
			},
			{
				fetch: async (
					_item: unknown,
					signal: AbortSignal | undefined,
					authorize: DestinationAuthorizer,
				) => {
					await authorize("https://final.example/docs/index.html", signal);
					return {
						type: "success",
						content: '<html><main>Redirected article</main><a href="child">child</a></html>',
						effectiveUrl: "https://final.example/docs/index.html",
						statusCode: 200,
						contentType: "text/html",
						contentLength: 2000,
						title: "",
						description: "",
						xRobotsTag: null,
					};
				},
			},
			{},
			{ log: mock(() => undefined) },
		);

		const result = await pipeline.process({
			url: "https://example.com/start",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(enqueueNormalized).toHaveBeenCalledWith(
			expect.objectContaining({ url: "https://final.example/docs/child" }),
		);
		expect(result.page?.eventPayload.url).toBe("https://example.com/start");
		expect(result.terminalEffects).toMatchObject({
			chargeDomainBudget: true,
			chargedDomain: "final.example",
		});
	});

	test("serializes redirects that converge on one destination delay lane", async () => {
		const reserveTimes: number[] = [];
		let nextAllowedAt = Date.now() + 10;
		const pipeline = createPipeline(
			{ crawlMethod: "full" },
			{
				timeUntilDomainReady: () => Math.max(nextAllowedAt - Date.now(), 0),
				reserveDomain: () => {
					reserveTimes.push(Date.now());
					nextAllowedAt = Date.now() + 30;
				},
			},
			{},
			{
				fetch: async (_item, signal, authorize) => {
					if (!authorize) throw new Error("destination authorizer missing");
					await authorize("https://shared.example/final", signal);
					return { type: "unsupported", statusCode: 200, contentType: "application/zip" };
				},
			},
			{},
			{ log: mock(() => undefined) },
		);

		await Promise.all(
			["one", "two"].map((source) =>
				pipeline.process({
					url: `https://${source}.example/`,
					domain: `${source}.example`,
					depth: 0,
					retries: 0,
				}),
			),
		);

		expect(reserveTimes).toHaveLength(2);
		expect((reserveTimes[1] ?? 0) - (reserveTimes[0] ?? 0)).toBeGreaterThanOrEqual(20);
	});

	test("rejects large HTML shells without readable content or link admission", async () => {
		const enqueueNormalized = mock(() => true);
		const pipeline = createPipeline(
			{},
			{},
			{ enqueueNormalized },
			{
				fetch: async () => ({
					type: "success",
					content: `<html><body><nav><a href="/shell-link">link</a></nav><script>${"x".repeat(2000)}</script></body></html>`,
					effectiveUrl: "https://example.com/shell",
					statusCode: 200,
					contentType: "text/html",
					contentLength: 2100,
					title: "",
					description: "",
					xRobotsTag: null,
				}),
			},
			{},
			{ log: mock(() => undefined) },
		);

		const result = await pipeline.process({
			url: "https://example.com/shell",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toMatchObject({ terminalOutcome: "failure" });
		expect(enqueueNormalized).not.toHaveBeenCalled();
		expect(result.page).toBeUndefined();
	});

	test("consumes structured processor errors as terminal failure", async () => {
		const releasePdfWork = mock(() => undefined);
		const pipeline = createPipeline(
			{},
			{},
			{},
			{
				fetch: async () => ({
					type: "success",
					content: Buffer.from("not a pdf"),
					effectiveUrl: "https://example.com/broken.pdf",
					statusCode: 200,
					contentType: "application/pdf",
					contentLength: 1000,
					title: "",
					description: "",
					xRobotsTag: null,
					releasePdfWork,
				}),
			},
			{},
			{ log: mock(() => undefined) },
		);

		const result = await pipeline.process({
			url: "https://example.com/broken.pdf",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toMatchObject({ terminalOutcome: "failure" });
		expect(result).toMatchObject({ terminalEffects: { chargeDomainBudget: true } });
		expect(result.page).toBeUndefined();
		expect(releasePdfWork).toHaveBeenCalledTimes(1);
	});

	test("releases PDF work when cancellation wins immediately after fetch", async () => {
		const controller = new AbortController();
		const releasePdfWork = mock(() => undefined);
		const pipeline = createPipeline(
			{},
			{},
			{},
			{
				fetch: async () => {
					controller.abort(new Error("cancelled after PDF fetch"));
					return {
						type: "success",
						content: Buffer.from("unused"),
						effectiveUrl: "https://example.com/file.pdf",
						statusCode: 200,
						contentType: "application/pdf",
						contentLength: 6,
						title: "",
						description: "",
						xRobotsTag: null,
						releasePdfWork,
					};
				},
			},
			{},
			{ log: mock(() => undefined) },
		);

		await expect(
			pipeline.process(
				{
					url: "https://example.com/file.pdf",
					domain: "example.com",
					depth: 0,
					retries: 0,
				},
				controller.signal,
			),
		).rejects.toThrow("cancelled after PDF fetch");
		await Promise.resolve();
		expect(releasePdfWork).toHaveBeenCalledTimes(1);
	});
});

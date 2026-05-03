import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
	API_PATHS,
	buildCrawlEventsPath,
	buildCrawlExportPath,
	buildPageContentPath,
	CRAWL_EXPORT_FORMAT_VALUES,
	CRAWL_ROUTE_SEGMENTS,
	isApiPath,
	isCrawlEventsPath,
	OPENAPI_CRAWL_EVENTS_PATH,
	OPENAPI_CRAWL_EXPORT_PATH,
	PAGE_ROUTE_SEGMENTS,
	ACTIVE_CRAWL_STATUS_VALUES,
	type CrawlCounters,
	type CrawlOptions,
	CrawlStatusValues,
	isActiveCrawlStatus,
	isCrawlListResponse,
	isCrawlOptions,
	isPendingCrawlStatus,
	isResumableCrawlStatus,
	isTerminalCrawlStatus,
	PENDING_CRAWL_STATUS_VALUES,
	RESUMABLE_CRAWL_STATUS_VALUES,
	TERMINAL_CRAWL_STATUS_VALUES,
	toResumableSessionSummary,
	type CrawlEventEnvelope,
	CrawlEventTypeValues,
	isCrawlEventEnvelope,
	isLiveCrawlEventType,
	isSettledCrawlEventType,
	isTerminalCrawlEventType,
	LIVE_CRAWL_EVENT_TYPE_VALUES,
	SETTLED_CRAWL_EVENT_TYPE_VALUES,
	TERMINAL_CRAWL_EVENT_TYPE_VALUES,
} from "../../../shared/contracts/index.js";
import { API_LIST_LIMIT_BOUNDS } from "../../../shared/contracts/http.js";
import {
	CrawlEventEnvelopeSchema,
	CrawlListQuerySchema,
	ResumableCrawlListQuerySchema,
} from "../../../shared/contracts/schemas.js";
import {
	shouldResetTheatreStatus,
	THEATRE_STATUS_VALUES,
} from "../../../src/theatreStatus.js";
import { createApp } from "../../app.js";
import type { AppLogger } from "../../config/logging.js";
import { createDynamicBrowserContextOptions } from "../../domain/crawl/DynamicRenderer.js";
import type { HttpClient, Resolver } from "../../plugins/security.js";
import { isHtmlLikeContentType } from "../../processors/contentTypes.js";
import { CrawlManager } from "../../runtime/CrawlManager.js";
import { EventStream } from "../../runtime/EventStream.js";
import { RuntimeRegistry } from "../../runtime/RuntimeRegistry.js";
import { createInMemoryStorage } from "../../storage/db.js";

const VALID_OPTIONS: CrawlOptions = {
	target: "https://example.com",
	crawlMethod: "full",
	crawlDepth: 2,
	crawlDelay: 250,
	maxPages: 20,
	maxPagesPerDomain: 0,
	maxConcurrentRequests: 2,
	retryLimit: 1,
	dynamic: false,
	respectRobots: true,
	contentOnly: false,
	saveMedia: true,
};

const COUNTERS: CrawlCounters = {
	pagesScanned: 1,
	successCount: 1,
	failureCount: 0,
	skippedCount: 0,
	linksFound: 2,
	mediaFiles: 0,
	totalDataKb: 3,
};

const SERVER_CONTRACTS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
);

function createLogger(): AppLogger {
	const noop = () => undefined;
	return {
		level: "info",
		info: noop,
		warn: noop,
		error: noop,
		debug: noop,
		fatal: noop,
		trace: noop,
		silent: noop,
		child: () => createLogger(),
		close: noop,
	} as unknown as AppLogger;
}

function buildBoundaryApp() {
	const storage = createInMemoryStorage();
	const eventStream = new EventStream();
	const runtimeRegistry = new RuntimeRegistry();
	const logger = createLogger();
	const resolver: Resolver = {
		assertPublicHostname: async () => {},
		resolveHost: async () => ["93.184.216.34"],
	};
	const httpClient: HttpClient = {
		fetch: async () =>
			new Response("<html><body><main>unused</main></body></html>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
	};
	const crawlManager = new CrawlManager({
		logger,
		repos: storage.repos,
		eventStream,
		registry: runtimeRegistry,
		resolver,
		httpClient,
	});

	return {
		app: createApp({
			logger,
			storage,
			resolver,
			httpClient,
			eventStream,
			runtimeRegistry,
			crawlManager,
		}),
		eventStream,
		storage,
	};
}

function buildEnvelope(
	type: (typeof CrawlEventTypeValues)[number],
): CrawlEventEnvelope {
	const base = {
		type,
		crawlId: "crawl-boundary",
		sequence: 1,
		timestamp: "2026-05-01T00:00:00.000Z",
	};

	switch (type) {
		case "crawl.started":
			return {
				...base,
				type,
				payload: { target: VALID_OPTIONS.target, resume: false },
			};
		case "crawl.progress":
			return {
				...base,
				type,
				payload: {
					counters: COUNTERS,
					queue: {
						activeRequests: 0,
						queueLength: 0,
						elapsedTime: 1,
						pagesPerSecond: 1,
					},
					elapsedSeconds: 1,
					pagesPerSecond: 1,
					stopReason: null,
				},
			};
		case "crawl.page":
			return {
				...base,
				type,
				payload: {
					id: null,
					url: VALID_OPTIONS.target,
					title: "Boundary",
					description: "Boundary page",
					content: "content",
					contentType: "text/html",
					domain: "example.com",
				},
			};
		case "crawl.log":
			return { ...base, type, payload: { message: "log" } };
		case "crawl.completed":
			return { ...base, type, payload: { counters: COUNTERS } };
		case "crawl.failed":
			return {
				...base,
				type,
				payload: { error: "failed", counters: COUNTERS },
			};
		case "crawl.stopped":
			return {
				...base,
				type,
				payload: { stopReason: "stopped", counters: COUNTERS },
			};
		case "crawl.paused":
			return {
				...base,
				type,
				payload: { stopReason: null, counters: COUNTERS },
			};
	}
}

describe("cross-boundary invariants", () => {
	test("shared contracts own crawl and event validation schemas", () => {
		expect(existsSync(join(SERVER_CONTRACTS_DIR, "crawl.ts"))).toBe(false);
		expect(existsSync(join(SERVER_CONTRACTS_DIR, "events.ts"))).toBe(false);

		expect(API_LIST_LIMIT_BOUNDS).toEqual({ min: 1, max: 100 });
		expect(CrawlListQuerySchema).toBeDefined();
		expect(ResumableCrawlListQuerySchema).toBeDefined();
		expect(CrawlEventEnvelopeSchema).toBeDefined();
	});

	test("browser-facing shared validation does not compile schemas with eval", async () => {
		const validationSource = await readFile(
			new URL("../../../shared/contracts/validation.ts", import.meta.url),
			"utf8",
		);

		expect(validationSource).not.toContain("TypeCompiler");
		expect(validationSource).not.toContain(".Compile(");
	});

	test("crawl statuses are classified in one exhaustive partition", () => {
		const partitions = [
			PENDING_CRAWL_STATUS_VALUES,
			ACTIVE_CRAWL_STATUS_VALUES,
			RESUMABLE_CRAWL_STATUS_VALUES,
			TERMINAL_CRAWL_STATUS_VALUES,
		];
		const flattened = partitions.flat();

		expect(new Set(flattened).size).toBe(flattened.length);
		expect([...flattened].sort()).toEqual([...CrawlStatusValues].sort());

		for (const status of CrawlStatusValues) {
			expect(isPendingCrawlStatus(status)).toBe(status === "pending");
			expect(isActiveCrawlStatus(status)).toBe(
				ACTIVE_CRAWL_STATUS_VALUES.includes(
					status as (typeof ACTIVE_CRAWL_STATUS_VALUES)[number],
				),
			);
			expect(isResumableCrawlStatus(status)).toBe(
				RESUMABLE_CRAWL_STATUS_VALUES.includes(
					status as (typeof RESUMABLE_CRAWL_STATUS_VALUES)[number],
				),
			);
			expect(isTerminalCrawlStatus(status)).toBe(
				TERMINAL_CRAWL_STATUS_VALUES.includes(
					status as (typeof TERMINAL_CRAWL_STATUS_VALUES)[number],
				),
			);
		}
	});

	test("crawl events are classified as live or settled and terminal events carry counters", () => {
		const eventPartitions = [
			LIVE_CRAWL_EVENT_TYPE_VALUES,
			SETTLED_CRAWL_EVENT_TYPE_VALUES,
		];
		const flattened = eventPartitions.flat();

		expect(new Set(flattened).size).toBe(flattened.length);
		expect([...flattened].sort()).toEqual([...CrawlEventTypeValues].sort());
		expect(
			TERMINAL_CRAWL_EVENT_TYPE_VALUES.every((type) =>
				SETTLED_CRAWL_EVENT_TYPE_VALUES.includes(type),
			),
		).toBe(true);

		for (const type of CrawlEventTypeValues) {
			const envelope = buildEnvelope(type);

			expect(isCrawlEventEnvelope(envelope)).toBe(true);
			expect(isLiveCrawlEventType(type)).toBe(
				LIVE_CRAWL_EVENT_TYPE_VALUES.includes(
					type as (typeof LIVE_CRAWL_EVENT_TYPE_VALUES)[number],
				),
			);
			expect(isSettledCrawlEventType(type)).toBe(
				SETTLED_CRAWL_EVENT_TYPE_VALUES.includes(
					type as (typeof SETTLED_CRAWL_EVENT_TYPE_VALUES)[number],
				),
			);
			expect(isTerminalCrawlEventType(type)).toBe(
				TERMINAL_CRAWL_EVENT_TYPE_VALUES.includes(
					type as (typeof TERMINAL_CRAWL_EVENT_TYPE_VALUES)[number],
				),
			);

			if (isTerminalCrawlEventType(type)) {
				expect("counters" in envelope.payload).toBe(true);
				expect(
					(envelope.payload as { counters: CrawlCounters }).counters,
				).toEqual(COUNTERS);
			}
		}
	});

	test("persisted crawl options must keep every required field and bound before resume", () => {
		expect(isCrawlOptions(VALID_OPTIONS)).toBe(true);

		for (const key of Object.keys(VALID_OPTIONS) as (keyof CrawlOptions)[]) {
			const options = { ...VALID_OPTIONS };
			delete options[key];

			expect(isCrawlOptions(options), key).toBe(false);
		}

		expect(isCrawlOptions({ ...VALID_OPTIONS, crawlDepth: 1.5 })).toBe(false);
		expect(isCrawlOptions({ ...VALID_OPTIONS, maxPages: 0 })).toBe(false);
		expect(
			isCrawlOptions({ ...VALID_OPTIONS, maxConcurrentRequests: "2" }),
		).toBe(false);
	});

	test("manual transports use the same route-builder contract as backend route templates", async () => {
		const templateEventsPath = `${API_PATHS.crawls}${CRAWL_ROUTE_SEGMENTS.events.replace(":id", "{id}")}`;
		const templateExportPath = `${API_PATHS.crawls}${CRAWL_ROUTE_SEGMENTS.export.replace(":id", "{id}")}`;
		const templatePageContentPath = `${API_PATHS.pages}${PAGE_ROUTE_SEGMENTS.content.replace(":id", "{id}")}`;

		expect(templateEventsPath).toBe(OPENAPI_CRAWL_EVENTS_PATH);
		expect(templateExportPath).toBe(OPENAPI_CRAWL_EXPORT_PATH);
		expect(templatePageContentPath).toBe("/api/pages/{id}/content");

		expect(buildCrawlEventsPath("crawl 1/2")).toBe(
			"/api/crawls/crawl%201%2F2/events",
		);
		expect(buildCrawlExportPath("crawl 1/2", "csv")).toBe(
			"/api/crawls/crawl%201%2F2/export?format=csv",
		);
		expect(buildPageContentPath(42)).toBe("/api/pages/42/content");
		expect(CRAWL_EXPORT_FORMAT_VALUES).toEqual(["json", "csv"]);
		expect(isApiPath("/api")).toBe(true);
		expect(isApiPath("/api/crawls")).toBe(true);
		expect(isApiPath("/apianalytics")).toBe(false);
		expect(isCrawlEventsPath("/api/crawls/crawl%201%2F2/events")).toBe(true);
		expect(isCrawlEventsPath("/api/crawls/crawl/1/events")).toBe(false);
		expect(isCrawlEventsPath("/api/search?q=/events")).toBe(false);

		const { app, eventStream, storage } = buildBoundaryApp();
		const crawlId = "route-contract";
		storage.repos.crawlRuns.createRun(
			crawlId,
			VALID_OPTIONS.target,
			VALID_OPTIONS,
		);
		const pageId = storage.repos.pages.save({
			crawlId,
			url: `${VALID_OPTIONS.target}/page`,
			domain: "example.com",
			contentType: "text/html",
			statusCode: 200,
			contentLength: 20,
			title: "Boundary page",
			description: "",
			content: "<main>Boundary</main>",
			isDynamic: false,
			lastModified: null,
			etag: null,
			processedContent: {
				extractedData: { mainContent: "Boundary" },
				metadata: {},
				analysis: {},
				media: [],
				links: [],
				errors: [],
			},
			links: [],
		});
		eventStream.publish(crawlId, "crawl.log", { message: "route contract" });

		const exportResponse = await app.handle(
			new Request(`http://localhost${buildCrawlExportPath(crawlId, "json")}`),
		);
		expect(exportResponse.status).toBe(200);

		const pageContentResponse = await app.handle(
			new Request(`http://localhost${buildPageContentPath(pageId)}`),
		);
		expect(pageContentResponse.status).toBe(200);

		const abortController = new AbortController();
		const eventsResponse = await app.handle(
			new Request(`http://localhost${buildCrawlEventsPath(crawlId)}`, {
				signal: abortController.signal,
			}),
		);
		expect(eventsResponse.status).toBe(200);
		expect(eventsResponse.headers.get("content-type")).toContain(
			"text/event-stream",
		);
		const reader = eventsResponse.body!.getReader();
		const { value, done } = await reader.read();
		expect(done).toBe(false);
		expect(new TextDecoder().decode(value)).toContain("data: ");
		await reader.cancel();
		abortController.abort();
	});

	test("resumable session DTO is a shared projection of the public crawl summary", () => {
		const summary = {
			id: "crawl-1",
			target: VALID_OPTIONS.target,
			status: "interrupted",
			options: VALID_OPTIONS,
			counters: COUNTERS,
			createdAt: "2026-05-01T00:00:00.000Z",
			startedAt: "2026-05-01T00:00:01.000Z",
			updatedAt: "2026-05-01T00:00:02.000Z",
			completedAt: null,
			stopReason: "restart",
			resumable: true,
		} as const;

		expect(toResumableSessionSummary(summary)).toEqual({
			id: "crawl-1",
			target: VALID_OPTIONS.target,
			status: "interrupted",
			pagesScanned: COUNTERS.pagesScanned,
			createdAt: "2026-05-01T00:00:00.000Z",
			updatedAt: "2026-05-01T00:00:02.000Z",
		});

		expect(isCrawlListResponse({ crawls: [summary] })).toBe(true);
		expect(isCrawlListResponse({ crawls: [{ id: "crawl-1" }] })).toBe(false);
		expect(
			isCrawlListResponse({
				crawls: [{ ...summary, counters: { pagesScanned: 1 } }],
			}),
		).toBe(false);
	});

	test("high-risk UI, rendering, and content gates keep their deny-by-default edges", () => {
		expect(isHtmlLikeContentType("text/html; charset=utf-8")).toBe(true);
		expect(isHtmlLikeContentType("application/xhtml+xml; charset=utf-8")).toBe(
			true,
		);
		expect(isHtmlLikeContentType("application/json")).toBe(false);

		expect(createDynamicBrowserContextOptions()).toMatchObject({
			serviceWorkers: "block",
		});

		for (const status of THEATRE_STATUS_VALUES) {
			expect(shouldResetTheatreStatus(status, false)).toBe(status !== "idle");
			expect(shouldResetTheatreStatus(status, true)).toBe(false);
		}
	});
});

import { describe, expect, expectTypeOf, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_LIST_LIMIT_BOUNDS } from "../../../shared/contracts/http.js";
import {
	ACTIVE_CRAWL_STATUS_VALUES,
	API_PATHS,
	buildCrawlEventsPath,
	buildCrawlExportPath,
	buildCrawlSnapshotPath,
	buildPageContentPath,
	CRAWL_EXPORT_FORMAT_VALUES,
	CRAWL_ROUTE_SEGMENTS,
	type CrawlCounters,
	type CrawlEventEnvelope,
	CrawlEventTypeValues,
	type CrawlOptions,
	CrawlStatusValues,
	isActiveCrawlStatus,
	isApiPath,
	isCrawlEventEnvelope,
	isCrawlEventsPath,
	isCrawlListResponse,
	isCrawlOptions,
	isLiveCrawlEventType,
	isPendingCrawlStatus,
	isResumableCrawlStatus,
	isSettledCrawlEventType,
	isTerminalCrawlEventType,
	isTerminalCrawlStatus,
	LIVE_CRAWL_EVENT_TYPE_VALUES,
	OPENAPI_CRAWL_EVENTS_PATH,
	OPENAPI_CRAWL_EXPORT_PATH,
	OPENAPI_CRAWL_SNAPSHOT_PATH,
	PAGE_ROUTE_SEGMENTS,
	PENDING_CRAWL_STATUS_VALUES,
	RESUMABLE_CRAWL_STATUS_VALUES,
	SETTLED_CRAWL_EVENT_TYPE_VALUES,
	TERMINAL_CRAWL_EVENT_TYPE_VALUES,
	TERMINAL_CRAWL_STATUS_VALUES,
	toResumableSessionSummary,
} from "../../../shared/contracts/index.js";
import {
	type CrawlCountersSchema,
	CrawlEventEnvelopeSchema,
	type CrawlOptionsSchema,
} from "../../../shared/contracts/schemas.js";
import { DEFAULT_BACKEND_PORT } from "../../../shared/deploymentDefaults.js";
import { shouldResetTheatreStatus, THEATRE_STATUS_VALUES } from "../../../shared/theatreStatus.js";
import { persistPageFixture } from "../../__tests__/pageFixture.js";
import { createApp } from "../../app.js";
import type { AppLogger } from "../../config/logging.js";
import { createDynamicBrowserContextOptions } from "../../domain/crawl/DynamicRenderer.js";
import type { HttpClient, Resolver } from "../../plugins/security.js";
import { isHtmlLikeContentType } from "../../processors/contentTypes.js";
import { CrawlManager } from "../../runtime/CrawlManager.js";
import type { CrawlRuntime } from "../../runtime/CrawlRuntime.js";
import { EventStream } from "../../runtime/EventStream.js";
import { createInMemoryStorage } from "../../storage/db.js";
import { CrawlListQuerySchema, ResumableCrawlListQuerySchema } from "../crawls.js";

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

function decodeSseChunk(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);
	throw new Error("Expected an SSE string or byte chunk");
}

const COUNTERS: CrawlCounters = {
	pagesScanned: 1,
	successCount: 1,
	failureCount: 0,
	skippedCount: 0,
	linksFound: 2,
	mediaFiles: 0,
	totalDataKb: 3,
};

const SERVER_CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

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
	} as unknown as AppLogger;
}

function buildBoundaryApp() {
	const storage = createInMemoryStorage();
	const eventStream = new EventStream();
	const runtimeRegistry = new Map<string, CrawlRuntime>();
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
			rateLimitGenerator: () => "cross-boundary-contract-client",
		}),
		eventStream,
		storage,
	};
}

function buildEnvelope(type: (typeof CrawlEventTypeValues)[number]): CrawlEventEnvelope {
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
					id: 1,
					pageCount: 1,
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

function expectBackendPortProjections(source: string, patterns: RegExp[]): void {
	const projectedPorts = patterns.flatMap((pattern) =>
		[...source.matchAll(pattern)].flatMap((match) =>
			match
				.slice(1)
				.filter((value): value is string => value !== undefined)
				.map(Number),
		),
	);

	expect(projectedPorts.length).toBeGreaterThan(0);
	expect([...new Set(projectedPorts)]).toEqual([DEFAULT_BACKEND_PORT]);
}

describe("cross-boundary invariants", () => {
	test("checked-in deployment projections match the authoritative backend default", async () => {
		const [environmentExample, dockerfile, readme, dockerDeployment] = await Promise.all([
			readFile(new URL("../../../.env.example", import.meta.url), "utf8"),
			readFile(new URL("../../../Dockerfile", import.meta.url), "utf8"),
			readFile(new URL("../../../README.md", import.meta.url), "utf8"),
			readFile(new URL("../../../docs/DOCKER_DEPLOY.md", import.meta.url), "utf8"),
		]);
		const readmeBackendProjections = readme
			.split("\n")
			.filter((line) => !line.includes("Frontend") && !line.startsWith("FRONTEND_URL="))
			.join("\n");

		expectBackendPortProjections(environmentExample, [/^PORT=(\d+)$/gm]);
		expectBackendPortProjections(dockerfile, [/^ENV PORT=(\d+)$|^EXPOSE (\d+)$/gm]);
		expectBackendPortProjections(readmeBackendProjections, [
			/localhost:(\d+)/g,
			/^PORT=(\d+)$/gm,
			/-p (\d+):(\d+)/g,
			/backend owns port `(\d+)`/gi,
		]);
		expectBackendPortProjections(dockerDeployment, [
			/localhost:(\d+)/g,
			/\bPORT=(\d+)\b/g,
			/-p (\d+):(\d+)/g,
			/\bPort (\d+) is a projection/g,
		]);
	});

	test("shared contracts own crawl and event validation schemas", () => {
		expect(existsSync(join(SERVER_CONTRACTS_DIR, "crawl.ts"))).toBe(false);
		expect(existsSync(join(SERVER_CONTRACTS_DIR, "events.ts"))).toBe(false);

		expect(API_LIST_LIMIT_BOUNDS).toEqual({ min: 1, max: 100 });
		expect(CrawlListQuerySchema).toBeDefined();
		expect(ResumableCrawlListQuerySchema).toBeDefined();
		expect(CrawlEventEnvelopeSchema).toBeDefined();
	});

	test("wire types are projections of their runtime schemas", () => {
		expectTypeOf<CrawlOptions>().toEqualTypeOf<typeof CrawlOptionsSchema.static>();
		expectTypeOf<CrawlCounters>().toEqualTypeOf<typeof CrawlCountersSchema.static>();
		expectTypeOf<CrawlEventEnvelope>().toEqualTypeOf<typeof CrawlEventEnvelopeSchema.static>();
	});

	test("browser-facing validation depends only on eval-free wire schemas", async () => {
		const [validationSource, schemaSource] = await Promise.all([
			readFile(new URL("../../../shared/contracts/validation.ts", import.meta.url), "utf8"),
			readFile(new URL("../../../shared/contracts/schemas.ts", import.meta.url), "utf8"),
		]);

		expect(validationSource).not.toContain("TypeCompiler");
		expect(validationSource).not.toContain(".Compile(");
		expect(schemaSource).toContain('from "elysia/type-system"');
		expect(schemaSource).not.toContain('from "./http.js"');
		expect(schemaSource).not.toContain("t.Numeric(");
	});

	test("crawl statuses have one exhaustive ownership partition and pending is active", () => {
		const partitions = [
			ACTIVE_CRAWL_STATUS_VALUES,
			RESUMABLE_CRAWL_STATUS_VALUES,
			TERMINAL_CRAWL_STATUS_VALUES,
		];
		const flattened = partitions.flat();

		expect(new Set(flattened).size).toBe(flattened.length);
		expect([...flattened].sort()).toEqual([...CrawlStatusValues].sort());
		expect(
			PENDING_CRAWL_STATUS_VALUES.every((status) => ACTIVE_CRAWL_STATUS_VALUES.includes(status)),
		).toBe(true);

		for (const status of CrawlStatusValues) {
			expect(isPendingCrawlStatus(status)).toBe(status === "pending");
			expect(isActiveCrawlStatus(status)).toBe(
				ACTIVE_CRAWL_STATUS_VALUES.includes(status as (typeof ACTIVE_CRAWL_STATUS_VALUES)[number]),
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
		const eventPartitions = [LIVE_CRAWL_EVENT_TYPE_VALUES, SETTLED_CRAWL_EVENT_TYPE_VALUES];
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
				expect((envelope.payload as { counters: CrawlCounters }).counters).toEqual(COUNTERS);
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
		expect(isCrawlOptions({ ...VALID_OPTIONS, maxConcurrentRequests: "2" })).toBe(false);
	});

	test("manual transports use the same route-builder contract as backend route templates", async () => {
		const templateEventsPath = `${API_PATHS.crawls}${CRAWL_ROUTE_SEGMENTS.events.replace(":id", "{id}")}`;
		const templateExportPath = `${API_PATHS.crawls}${CRAWL_ROUTE_SEGMENTS.export.replace(":id", "{id}")}`;
		const templateSnapshotPath = `${API_PATHS.crawls}${CRAWL_ROUTE_SEGMENTS.snapshot.replace(":id", "{id}")}`;
		const templatePageContentPath = `${API_PATHS.pages}${PAGE_ROUTE_SEGMENTS.content.replace(":id", "{id}")}`;

		expect(templateEventsPath).toBe(OPENAPI_CRAWL_EVENTS_PATH);
		expect(templateExportPath).toBe(OPENAPI_CRAWL_EXPORT_PATH);
		expect(templateSnapshotPath).toBe(OPENAPI_CRAWL_SNAPSHOT_PATH);
		expect(templatePageContentPath).toBe("/api/pages/{id}/content");

		expect(buildCrawlEventsPath("crawl 1/2")).toBe("/api/crawls/crawl%201%2F2/events");
		expect(buildCrawlExportPath("crawl 1/2", "csv")).toBe(
			"/api/crawls/crawl%201%2F2/export?format=csv",
		);
		expect(buildCrawlSnapshotPath("crawl 1/2")).toBe("/api/crawls/crawl%201%2F2/snapshot");
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
		storage.repos.crawlRuns.createRun(crawlId, VALID_OPTIONS);
		const pageId = persistPageFixture(storage, {
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

		const snapshotResponse = await app.handle(
			new Request(`http://localhost${buildCrawlSnapshotPath(crawlId)}`),
		);
		expect(snapshotResponse.status).toBe(200);
		expect(await snapshotResponse.json()).toEqual(expect.objectContaining({ pageCount: 1 }));

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
		expect(eventsResponse.headers.get("content-type")).toContain("text/event-stream");
		if (!eventsResponse.body) {
			throw new Error("Expected crawl event response to include a stream body");
		}
		const reader = eventsResponse.body.getReader();
		const { value, done } = await reader.read();
		expect(done).toBe(false);
		expect(decodeSseChunk(value)).toContain("data: ");
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
		expect(isHtmlLikeContentType("application/xhtml+xml; charset=utf-8")).toBe(true);
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

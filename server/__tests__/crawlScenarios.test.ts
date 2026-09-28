import { describe, expect, test } from "bun:test";
import type { CrawlEventEnvelope, CrawlOptions } from "../../shared/contracts/index.js";
import { PinnedHttpClient, type Resolver } from "../outbound/HttpClient.js";
import { CrawlManager } from "../runtime/CrawlManager.js";
import { EventStream } from "../runtime/EventStream.js";
import type { Storage } from "../storage/db.js";
import { silentLogger, waitFor } from "./runtimeFixture.js";
import { createInMemoryStorage } from "./storageFixture.js";

/**
 * End-to-end crawl scenarios: the real manager, runtime, pipeline, robots policy, pinned
 * HTTP client (redirects, headers), and SQLite storage, against an in-process site. Only
 * DNS and sockets are replaced, by a public-address resolver and a routing fetch.
 */

const SITE = "https://site.test";
const PUBLIC_ADDRESS = "93.184.216.34";

type Route = () => Response | Promise<Response>;

const page = (title: string, body: string, head = "") =>
	new Response(
		`<html><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1><p>${body}</p><p>${"Readable crawler fixture text. ".repeat(20)}</p></main></body></html>`,
		{ headers: { "content-type": "text/html; charset=utf-8" } },
	);

const link = (path: string, rel = "") =>
	`<a href="${path}"${rel ? ` rel="${rel}"` : ""}>${path}</a>`;

function fixtureSite(): Record<string, Route> {
	return {
		"/robots.txt": () => new Response("User-agent: *\nDisallow: /private\n"),
		"/": () =>
			page(
				"Home",
				[
					link("/a"),
					link("/b"),
					link("/old"),
					link("/private"),
					link("/sponsored", "nofollow"),
					link("/noindex"),
					link("/missing"),
					link("/app.js"),
				].join(" "),
			),
		"/a": () => page("Page A", link("/")),
		"/b": () => page("Page B", link("/a")),
		"/old": () => new Response(null, { status: 301, headers: { location: "/c" } }),
		"/c": () => page("Page C", "redirect destination"),
		"/private": () => page("Private", "must not be fetched"),
		"/sponsored": () => page("Sponsored", "must not be followed"),
		"/noindex": () => page("Hidden", link("/d"), '<meta name="robots" content="noindex">'),
		"/d": () => page("Page D", "reached through a noindex page"),
		"/missing": () => new Response("gone", { status: 404 }),
	};
}

function createSiteClient(routes: Record<string, Route>, requested: string[]) {
	const resolver: Resolver = {
		resolveHost: async () => [PUBLIC_ADDRESS],
		assertPublicHostname: async () => {},
	};
	const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const host = new Headers(init?.headers).get("host");
		expect(url.hostname).toBe(PUBLIC_ADDRESS);
		expect(host).toBe("site.test");
		requested.push(url.pathname);
		const route = routes[url.pathname];
		return route ? route() : new Response("not found", { status: 404 });
	}) as typeof fetch;
	return new PinnedHttpClient(resolver, fetchFn);
}

function crawlOptions(overrides: Partial<CrawlOptions> = {}): CrawlOptions {
	return {
		target: `${SITE}/`,
		crawlMethod: "links",
		crawlDepth: 2,
		crawlDelay: 200,
		maxPages: 50,
		maxPagesPerDomain: 0,
		maxConcurrentRequests: 2,
		retryLimit: 0,
		dynamic: false,
		respectRobots: true,
		contentOnly: false,
		saveMedia: false,
		...overrides,
	};
}

function startScenario(
	routes = fixtureSite(),
	storage: Storage = createInMemoryStorage(),
): {
	manager: CrawlManager;
	storage: Storage;
	eventStream: EventStream;
	requested: string[];
} {
	const requested: string[] = [];
	const eventStream = new EventStream();
	const manager = new CrawlManager({
		logger: silentLogger,
		repos: storage.repos,
		eventStream,
		httpClient: createSiteClient(routes, requested),
		storageBudget: storage.budget,
	});
	return { manager, storage, eventStream, requested };
}

function storedPaths(storage: Storage, crawlId: string): string[] {
	return Array.from(
		storage.repos.pages.iterateForExport(crawlId),
		(row) => new URL(row.url).pathname,
	).sort();
}

async function settled(storage: Storage, crawlId: string, status: string) {
	return waitFor(
		() => storage.repos.crawlRuns.getById(crawlId),
		(crawl) => crawl?.status === status,
	);
}

describe("crawl scenarios", () => {
	test("a full crawl applies link, robots, redirect, and indexing policy", async () => {
		const { manager, storage, eventStream, requested } = startScenario();
		const crawlId = crypto.randomUUID();
		const events: CrawlEventEnvelope[] = [];
		manager.create(crawlId, crawlOptions());
		eventStream.subscribe(crawlId, (event) => events.push(event));

		const completed = await settled(storage, crawlId, "completed");

		// Stored: indexable HTML pages. Not stored: robots-disallowed, nofollow, noindex,
		// resource extensions, and failures. The noindex page's links are still followed.
		// A redirected page is stored under the URL that was queued, fetched at its destination.
		expect(storedPaths(storage, crawlId)).toEqual(["/", "/a", "/b", "/d", "/old"]);
		expect(requested).not.toContain("/private");
		expect(requested).not.toContain("/sponsored");
		expect(requested).not.toContain("/app.js");
		expect(requested).toContain("/old");
		expect(requested).toContain("/c");
		expect(requested).toContain("/noindex");
		expect(completed?.counters).toMatchObject({
			pagesScanned: 7,
			successCount: 5,
			failureCount: 1,
			skippedCount: 1,
		});

		const sequences = events.map((event) => event.sequence);
		expect(sequences).toEqual(sequences.map((_, index) => (sequences[0] ?? 0) + index));
		expect(events.at(-1)?.type).toBe("crawl.completed");
		expect(completed?.eventSequence).toBe(events.at(-1)?.sequence);
		expect(storage.repos.crawlQueue.listPending(crawlId)).toEqual([]);
	}, 30_000);

	test("pause then resume finishes the remaining work without refetching stored pages", async () => {
		const { manager, storage, requested } = startScenario();
		const crawlId = crypto.randomUUID();
		manager.create(crawlId, crawlOptions({ maxConcurrentRequests: 1 }));
		await waitFor(
			() => storage.repos.crawlRuns.getById(crawlId)?.counters.pagesScanned ?? 0,
			(scanned) => scanned >= 2,
		);

		await manager.stop(crawlId, "pause");
		const paused = storage.repos.crawlRuns.getById(crawlId);
		expect(paused?.status).toBe("paused");
		const storedBeforeResume = storedPaths(storage, crawlId);
		const fetchesBeforeResume = requested.filter((path) => path !== "/robots.txt").length;

		expect(manager.resume(crawlId).type).toBe("resumed");
		await settled(storage, crawlId, "completed");

		expect(storedPaths(storage, crawlId)).toEqual(["/", "/a", "/b", "/d", "/old"]);
		const resumedFetches = requested
			.filter((path) => path !== "/robots.txt")
			.slice(fetchesBeforeResume);
		for (const path of storedBeforeResume) expect(resumedFetches).not.toContain(path);
	}, 30_000);

	test("a crawl interrupted by shutdown resumes in a new process to the same result", async () => {
		const storage = createInMemoryStorage();
		const first = startScenario(fixtureSite(), storage);
		const crawlId = crypto.randomUUID();
		first.manager.create(crawlId, crawlOptions({ maxConcurrentRequests: 1 }));
		await waitFor(
			() => storage.repos.crawlRuns.getById(crawlId)?.counters.pagesScanned ?? 0,
			(scanned) => scanned >= 2,
		);

		await first.manager.shutdownAll();
		expect(storage.repos.crawlRuns.getById(crawlId)?.status).toBe("interrupted");

		const second = startScenario(fixtureSite(), storage);
		second.manager.recoverOrphanedActiveCrawls();
		expect(second.manager.resume(crawlId).type).toBe("resumed");
		const completed = await settled(storage, crawlId, "completed");

		expect(storedPaths(storage, crawlId)).toEqual(["/", "/a", "/b", "/d", "/old"]);
		expect(completed?.counters.pagesScanned).toBe(7);
	}, 30_000);

	test("force stop discards pending work and ends the crawl as stopped", async () => {
		const { manager, storage } = startScenario();
		const crawlId = crypto.randomUUID();
		manager.create(crawlId, crawlOptions({ maxConcurrentRequests: 1 }));
		await waitFor(
			() => storage.repos.crawlRuns.getById(crawlId)?.counters.pagesScanned ?? 0,
			(scanned) => scanned >= 1,
		);

		await manager.stop(crawlId, "force");

		const stopped = storage.repos.crawlRuns.getById(crawlId);
		expect(stopped?.status).toBe("stopped");
		expect(stopped?.resumable).toBe(false);
		expect(storage.repos.crawlQueue.listPending(crawlId)).toEqual([]);
		expect(manager.resume(crawlId).type).toBe("not-resumable");
	}, 30_000);

	test("retrying a create with the same identity starts exactly one crawl", async () => {
		const { manager, storage } = startScenario();
		const crawlId = crypto.randomUUID();
		const options = crawlOptions({ maxPages: 1 });

		const first = manager.create(crawlId, options);
		const retried = manager.create(crawlId, { ...options });
		await settled(storage, crawlId, "completed");

		expect(retried.id).toBe(first.id);
		expect(storage.repos.crawlRuns.list({ limit: 25 })).toHaveLength(1);
	}, 30_000);
});

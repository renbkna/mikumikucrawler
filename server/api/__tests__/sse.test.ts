import { expect, test } from "bun:test";
import { silentLogger, successfulHtmlHttpClient } from "../../__tests__/runtimeFixture.js";
import {
	createCrawlOptionsFixture,
	createInMemoryStorage,
} from "../../__tests__/storageFixture.js";
import { CrawlManager } from "../../runtime/CrawlManager.js";
import { EventStream } from "../../runtime/EventStream.js";
import { routeServicesPlugin } from "../context.js";
import { sseApi } from "../sse.js";

test("SSE admission observes deletion while client identity is resolving", async () => {
	const storage = createInMemoryStorage();
	const eventStream = new EventStream();
	const crawlManager = new CrawlManager({
		logger: silentLogger,
		repos: storage.repos,
		eventStream,
		httpClient: successfulHtmlHttpClient,
		storageBudget: storage.budget,
	});
	const identityRequested = Promise.withResolvers<void>();
	const clientKey = Promise.withResolvers<string>();
	const crawlId = "deleted-during-sse-admission";
	const app = sseApi(
		routeServicesPlugin({
			crawlManager,
			eventStream,
			repos: storage.repos,
			resolveClientKey: () => {
				identityRequested.resolve();
				return clientKey.promise;
			},
		}),
	);
	try {
		const record = storage.repos.crawlRuns.createRun(crawlId, createCrawlOptionsFixture());
		storage.repos.crawlRuns.markCompleted(crawlId, null, 1);
		eventStream.initialize(crawlId);
		eventStream.publish(crawlId, "crawl.completed", { counters: record.counters });
		const connecting = app.handle(new Request(`http://localhost/api/crawls/${crawlId}/events`));
		await identityRequested.promise;
		expect(crawlManager.delete(crawlId)).toEqual({ type: "deleted" });
		clientKey.resolve("sse-contract-client");
		const response = await connecting;
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Crawl not found" });
	} finally {
		clientKey.resolve("sse-contract-client");
		eventStream.close();
		storage.close();
	}
});

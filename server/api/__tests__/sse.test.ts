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

test("SSE answers 204 for a crawl without a live runtime, so clients read its snapshot", async () => {
	const storage = createInMemoryStorage();
	const eventStream = new EventStream();
	const crawlManager = new CrawlManager({
		logger: silentLogger,
		repos: storage.repos,
		eventStream,
		httpClient: successfulHtmlHttpClient,
		storageBudget: storage.budget,
	});
	const app = sseApi(
		routeServicesPlugin({
			crawlManager,
			eventStream,
			repos: storage.repos,
			resolveClientKey: () => "sse-contract-client",
			keepOpen: () => {},
		}),
	);
	try {
		// A completed crawl and an orphaned "running" row both lack a publishing runtime.
		storage.repos.crawlRuns.createRun("settled", createCrawlOptionsFixture());
		storage.repos.crawlRuns.transition("settled", "completed", { eventSequence: 3 });
		storage.repos.crawlRuns.createRun("orphaned", createCrawlOptionsFixture());
		storage.repos.crawlRuns.transition("orphaned", "running", { eventSequence: 3 });

		for (const crawlId of ["settled", "orphaned"]) {
			const response = await app.handle(
				new Request(`http://localhost/api/crawls/${crawlId}/events`),
			);
			expect(response.status).toBe(204);
		}
	} finally {
		eventStream.close();
		storage.close();
	}
});

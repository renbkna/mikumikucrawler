import { describe, expect, mock, test } from "bun:test";
import type { Logger } from "../../../config/logging.js";
import { FetchService } from "../FetchService.js";

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

describe("fetch service contract", () => {
	test("does not fall back to static crawl when a strict consent wall blocks dynamic rendering", async () => {
		const httpFetch = mock(async () => new Response("should not be called"));
		const service = new FetchService(
			{
				getHeaders: () => null,
			} as never,
			{ fetch: httpFetch },
			{
				isEnabled: () => true,
				render: async () => ({
					type: "consentBlocked",
					message:
						"Consent wall could not be bypassed for https://www.youtube.com/watch?v=test",
					statusCode: 403,
				}),
			} as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://www.youtube.com/watch?v=test",
			domain: "www.youtube.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toEqual({
			type: "blocked",
			statusCode: 403,
			reason:
				"Consent wall could not be bypassed for https://www.youtube.com/watch?v=test",
		});
		expect(httpFetch).not.toHaveBeenCalled();
	});

	test("maps browser-rendered 403 responses to blocked instead of success", async () => {
		const service = new FetchService(
			{
				getHeaders: () => null,
			} as never,
			{
				fetch: mock(async () => new Response("should not be called")),
			},
			{
				isEnabled: () => true,
				render: async () => ({
					type: "success",
					result: {
						isDynamic: true,
						content: "<html>blocked</html>",
						statusCode: 403,
						contentType: "text/html",
						contentLength: 20,
						title: "Blocked",
						description: "",
						lastModified: undefined,
						xRobotsTag: null,
					},
				}),
			} as never,
			createLogger(),
		);

		const result = await service.fetch("crawl-1", {
			url: "https://example.com/blocked",
			domain: "example.com",
			depth: 0,
			retries: 0,
		});

		expect(result).toEqual({
			type: "blocked",
			statusCode: 403,
			reason: "Access blocked for https://example.com/blocked",
		});
	});
});

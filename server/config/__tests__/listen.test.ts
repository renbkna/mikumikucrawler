import { expect, test } from "bun:test";
import { createServerListenOptions, MAX_API_REQUEST_BODY_BYTES } from "../listen.js";

test("server listen policy owns the API request-body ceiling", () => {
	expect(createServerListenOptions(3000).maxRequestBodySize).toBe(MAX_API_REQUEST_BODY_BYTES);
});

test("localhost crawl capability implies a loopback-only listener", () => {
	expect(createServerListenOptions(3000, true).hostname).toBe("127.0.0.1");
	expect(createServerListenOptions(3000, false).hostname).toBe("0.0.0.0");
});

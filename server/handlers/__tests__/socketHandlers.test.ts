import assert from "node:assert/strict";
import dns from "node:dns";
import test from "node:test";
import { sanitizeOptions } from "../socketHandlers.js";

test("sanitizeOptions rejects direct localhost access", async () => {
	await assert.rejects(
		() => sanitizeOptions({ target: "http://127.0.0.1" }),
		/Target host is not allowed/,
	);

	await assert.rejects(
		() => sanitizeOptions({ target: "http://[::1]" }),
		/Target host is not allowed/,
	);

	await assert.rejects(
		() => sanitizeOptions({ target: "http://[::ffff:127.0.0.1]" }),
		/Target host is not allowed/,
	);
});

test("sanitizeOptions rejects unresolvable hostnames", async (t) => {
	t.mock.method(dns.promises, "lookup", async () => {
		const err: Error & { code?: string } = new Error("ENOTFOUND");
		err.code = "ENOTFOUND";
		throw err;
	});

	await assert.rejects(
		() => sanitizeOptions({ target: "https://not-a-real-domain.invalid" }),
		/Unable to resolve target hostname/,
	);
});

test("sanitizeOptions allows public hosts and normalises options", async (t) => {
	t.mock.method(dns.promises, "lookup", async () => [
		{ address: "93.184.216.34", family: 4 },
	]);

	const options = await sanitizeOptions({
		target: "example.com",
		crawlDepth: 4,
		maxPages: 100,
		crawlDelay: 750,
		maxConcurrentRequests: 3,
		retryLimit: 2,
		dynamic: true,
		respectRobots: true,
		contentOnly: false,
	});

	assert.strictEqual(options.target, "http://example.com/");
	assert.strictEqual(options.crawlDepth, 4);
	assert.strictEqual(options.maxPages, 100);
	assert.strictEqual(options.crawlDelay, 750);
	assert.strictEqual(options.maxConcurrentRequests, 3);
	assert.strictEqual(options.retryLimit, 2);
	assert.strictEqual(options.dynamic, true);
	assert.strictEqual(options.respectRobots, true);
	assert.strictEqual(options.contentOnly, false);
});

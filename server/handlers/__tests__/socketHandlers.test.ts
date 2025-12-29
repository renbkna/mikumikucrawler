import { describe, expect, mock, test } from "bun:test";
import dns from "node:dns";
import { sanitizeOptions } from "../socketHandlers.js";

describe("sanitizeOptions", () => {
	test("rejects direct localhost access", async () => {
		expect(sanitizeOptions({ target: "http://127.0.0.1" })).rejects.toThrow(
			/Target host is not allowed/,
		);

		expect(sanitizeOptions({ target: "http://[::1]" })).rejects.toThrow(
			/Target host is not allowed/,
		);

		expect(
			sanitizeOptions({ target: "http://[::ffff:127.0.0.1]" }),
		).rejects.toThrow(/Target host is not allowed/);
	});

	test("rejects unresolvable hostnames", async () => {
		const originalLookup = dns.promises.lookup;
		dns.promises.lookup = mock(async () => {
			const err: Error & { code?: string } = new Error("ENOTFOUND");
			err.code = "ENOTFOUND";
			throw err;
		}) as unknown as typeof dns.promises.lookup;

		try {
			// Because assertPublicHostname checks net.isIP first, "not-a-real-domain.invalid" isn't an IP, so it hits lookup.
			await expect(
				sanitizeOptions({ target: "https://not-a-real-domain.invalid" }),
			).rejects.toThrow(/Unable to resolve target hostname/);
		} finally {
			dns.promises.lookup = originalLookup;
		}
	});

	test("allows public hosts and normalises options", async () => {
		const originalLookup = dns.promises.lookup;
		dns.promises.lookup = mock(async () => [
			{ address: "93.184.216.34", family: 4 },
		]) as unknown as typeof dns.promises.lookup;

		try {
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

			expect(options.target).toBe("http://example.com/");
			expect(options.crawlDepth).toBe(4);
			expect(options.maxPages).toBe(100);
			expect(options.crawlDelay).toBe(750);
			expect(options.maxConcurrentRequests).toBe(3);
			expect(options.retryLimit).toBe(2);
			expect(options.dynamic).toBe(true);
			expect(options.respectRobots).toBe(true);
			expect(options.contentOnly).toBe(false);
		} finally {
			dns.promises.lookup = originalLookup;
		}
	});
});

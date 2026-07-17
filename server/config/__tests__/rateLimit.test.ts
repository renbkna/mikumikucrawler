import { describe, expect, test } from "bun:test";
import { resolveRateLimitKey } from "../rateLimit.js";

describe("rate-limit client identity", () => {
	test("trusts Render's first forwarded address only at the Render boundary", () => {
		expect(
			resolveRateLimitKey({
				directAddress: "10.0.0.2",
				forwardedFor: "203.0.113.8, 10.0.0.1",
				trustRenderProxy: true,
			}),
		).toBe("203.0.113.8");

		expect(
			resolveRateLimitKey({
				directAddress: "198.51.100.4",
				forwardedFor: "203.0.113.8",
				trustRenderProxy: false,
			}),
		).toBe("198.51.100.4");
	});

	test("falls back to the socket peer for malformed proxy input", () => {
		expect(
			resolveRateLimitKey({
				directAddress: "198.51.100.4",
				forwardedFor: "spoofed-client",
				trustRenderProxy: true,
			}),
		).toBe("198.51.100.4");
	});

	test("places unidentified clients in one conservative shared bucket", () => {
		expect(
			resolveRateLimitKey({
				forwardedFor: "spoofed-client",
				trustRenderProxy: true,
			}),
		).toBe("unidentified-client");
	});
});

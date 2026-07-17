import { describe, expect, test } from "bun:test";
import { allowsLocalhostTargets, resolveRobotsProductToken } from "../env.js";

describe("environment policy", () => {
	test("rejects a non-positive memory threshold at the configuration boundary", () => {
		const result = Bun.spawnSync({
			cmd: [process.execPath, "-e", 'await import("./server/config/env.ts")'],
			cwd: process.cwd(),
			env: { ...process.env, MEMORY_THRESHOLD_MB: "0" },
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain(
			"Invalid MEMORY_THRESHOLD_MB=0 — must be at least 1.",
		);
	});

	test("localhost targets are an explicit development-only capability", () => {
		expect(allowsLocalhostTargets("development")).toBe(true);
		expect(allowsLocalhostTargets("production")).toBe(false);
		expect(allowsLocalhostTargets("staging")).toBe(false);
		expect(allowsLocalhostTargets("preview")).toBe(false);
	});

	test("robots matching uses an explicit RFC product token for detailed user agents", () => {
		expect(resolveRobotsProductToken("MikuCrawler/3.0.0")).toBe("MikuCrawler");
		expect(
			resolveRobotsProductToken(
				"Mozilla/5.0 (compatible; MikuCrawler/3.0; +https://example.test/bot)",
				"MikuCrawler",
			),
		).toBe("MikuCrawler");
		expect(() =>
			resolveRobotsProductToken(
				"Mozilla/5.0 (compatible; MikuCrawler/3.0; +https://example.test/bot)",
			),
		).toThrow("ROBOTS_PRODUCT_TOKEN is required");
		expect(() => resolveRobotsProductToken("MikuCrawler/3.0.0", "Miku Crawler")).toThrow(
			"Invalid ROBOTS_PRODUCT_TOKEN",
		);
	});
});

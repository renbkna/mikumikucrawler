import { describe, expect, test } from "bun:test";
import {
	DEFAULT_BACKEND_PORT,
	developmentBackendUrl,
	resolveBackendPort,
} from "../../../shared/deploymentDefaults.js";
import {
	allowsLocalhostTargets,
	MAX_MEMORY_THRESHOLD_MB,
	MAX_STORAGE_BUDGET_MB,
	parseFrontendOrigin,
	resolveRobotsProductToken,
} from "../env.js";

function importEnvironment(overrides: Record<string, string>) {
	return Bun.spawnSync({
		cmd: [process.execPath, "-e", 'await import("./server/config/env.ts")'],
		cwd: process.cwd(),
		env: { ...process.env, ...overrides },
		stdout: "pipe",
		stderr: "pipe",
	});
}

describe("environment policy", () => {
	test("one validated PORT value owns the local backend endpoint", () => {
		expect(resolveBackendPort(undefined)).toBe(DEFAULT_BACKEND_PORT);
		expect(developmentBackendUrl(resolveBackendPort("4123"))).toBe("http://localhost:4123");
		for (const rawPort of ["0", "65536", "3.5", "not-a-port"]) {
			expect(() => resolveBackendPort(rawPort)).toThrow();
		}
	});

	test("rejects invalid deployment settings at the configuration boundary", () => {
		const cases: Array<{ overrides: Record<string, string>; message?: string }> = [
			{
				overrides: { MEMORY_THRESHOLD_MB: "0" },
				message: `Invalid MEMORY_THRESHOLD_MB=0 — must be between 1 and ${MAX_MEMORY_THRESHOLD_MB}.`,
			},
			{ overrides: { MEMORY_THRESHOLD_MB: String(MAX_MEMORY_THRESHOLD_MB + 1) } },
			{ overrides: { MEMORY_THRESHOLD_MB: "9".repeat(400) } },
			{ overrides: { MAX_STORAGE_MB: "0" } },
			{ overrides: { MAX_STORAGE_MB: String(MAX_STORAGE_BUDGET_MB + 1) } },
			{ overrides: { MAX_STORAGE_MB: "not-a-number" } },
			{ overrides: { RENDER: "TRUE" }, message: 'expected "true" or "false"' },
		];

		for (const { overrides, message } of cases) {
			const result = importEnvironment(overrides);
			expect(result.exitCode).not.toBe(0);
			if (message) expect(result.stderr.toString()).toContain(message);
		}
	});

	test("FRONTEND_URL is one canonical HTTP origin", () => {
		expect(parseFrontendOrigin("https://crawler.example/")).toBe("https://crawler.example");
		expect(parseFrontendOrigin("https://crawler.example:443")).toBe("https://crawler.example");
		for (const raw of [
			"https://user@crawler.example",
			"https://crawler.example/app",
			"https://crawler.example?mode=prod",
			"file:///tmp/app",
		]) {
			expect(() => parseFrontendOrigin(raw)).toThrow("Invalid FRONTEND_URL");
		}
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
		expect(() => resolveRobotsProductToken("OtherCrawler/1.0", "MikuCrawler")).toThrow(
			"must identify a product token present in USER_AGENT",
		);
	});
});

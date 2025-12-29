import { describe, expect, mock, test } from "bun:test";
import type { DatabaseLike, LoggerLike } from "../../types.js";
import { getRobotsRules } from "../helpers.js";

const createLogger = (): LoggerLike => ({
	warn: mock(() => {}),
	info: mock(() => {}),
	error: mock(() => {}),
});

const createMockDb = (): DatabaseLike => ({
	query: mock(() => ({
		get: mock(() => null),
		all: mock(() => []),
		run: mock(() => {}),
	})),
});

describe("getRobotsRules", () => {
	test("returns permissive parser when download fails", async () => {
		const logger = createLogger();
		const db = createMockDb();

		// biome-ignore lint/suspicious/noExplicitAny: Mocking global fetch
		global.fetch = mock(() => Promise.reject(new Error("network down"))) as any;

		const robots = await getRobotsRules(
			"fallback.example",
			Promise.resolve(db),
			logger,
		);

		expect(robots).toBeTruthy();
		expect(robots?.isAllowed("http://fallback.example/", "MikuCrawler")).toBe(
			true,
		);
	});

	test("can surface null when allowOnFailure is false", async () => {
		const logger = createLogger();
		const db = createMockDb();

		// biome-ignore lint/suspicious/noExplicitAny: Mocking global fetch
		global.fetch = mock(() => Promise.reject(new Error("network down"))) as any;

		const robots = await getRobotsRules(
			"strict.example",
			Promise.resolve(db),
			logger,
			{ allowOnFailure: false },
		);

		expect(robots).toBeNull();
	});
});

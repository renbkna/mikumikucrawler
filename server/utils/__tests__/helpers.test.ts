import { describe, expect, mock, test } from "bun:test";
import { config } from "../../config/env.js";
import type { DatabaseLike, LoggerLike } from "../../types.js";
import { getErrorMessage, getRobotsRules } from "../helpers.js";

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

		globalThis.fetch = mock(() =>
			Promise.reject(new Error("network down")),
		) as unknown as typeof fetch;

		const robots = await getRobotsRules(
			"fallback.example",
			Promise.resolve(db),
			logger,
		);

		expect(robots).toBeTruthy();
		expect(
			robots?.isAllowed("http://fallback.example/", config.userAgent),
		).toBe(true);
	});

	test("can surface null when allowOnFailure is false", async () => {
		const logger = createLogger();
		const db = createMockDb();

		globalThis.fetch = mock(() =>
			Promise.reject(new Error("network down")),
		) as unknown as typeof fetch;

		const robots = await getRobotsRules(
			"strict.example",
			Promise.resolve(db),
			logger,
			{ allowOnFailure: false },
		);

		expect(robots).toBeNull();
	});
});

describe("getErrorMessage", () => {
	test("extracts message from Error instance", () => {
		const error = new Error("test error message");
		expect(getErrorMessage(error)).toBe("test error message");
	});

	test("returns string directly if error is string", () => {
		expect(getErrorMessage("string error")).toBe("string error");
	});

	test("converts non-Error objects to string", () => {
		expect(getErrorMessage({ code: 500 })).toBe("[object Object]");
		expect(getErrorMessage(42)).toBe("42");
		expect(getErrorMessage(null)).toBe("null");
		expect(getErrorMessage(undefined)).toBe("undefined");
	});

	test("handles TypeError correctly", () => {
		const error = new TypeError("type error message");
		expect(getErrorMessage(error)).toBe("type error message");
	});
});

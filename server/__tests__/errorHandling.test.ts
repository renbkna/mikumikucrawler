import { describe, expect, mock, test } from "bun:test";
import { Elysia, t } from "elysia";
import type { LoggerLike } from "../types.js";
import { handleAppError } from "../errorHandling.js";

function createLogger(): LoggerLike & {
	error: ReturnType<typeof mock>;
} {
	return {
		error: mock(() => undefined),
		info: mock(() => undefined),
		warn: mock(() => undefined),
		debug: mock(() => undefined),
	} as unknown as LoggerLike & {
		error: ReturnType<typeof mock>;
	};
}

describe("app error handling", () => {
	test("preserves validation errors as 422 responses", async () => {
		const logger = createLogger();
		const app = new Elysia()
			.onError(({ code, error, set }) =>
				handleAppError({
					code,
					error,
					set,
					logger,
				}),
			)
			.post("/value", ({ body }) => body, {
				body: t.Object({
					value: t.Number(),
				}),
			});

		const response = await app.handle(
			new Request("http://localhost/value", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ value: "wrong" }),
			}),
		);

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: "Expected number",
			details: [{ path: "/value", message: "Expected number" }],
		});
		expect(logger.error).not.toHaveBeenCalled();
	});

	test("preserves parse errors as 400 responses", async () => {
		const logger = createLogger();
		const app = new Elysia()
			.onError(({ code, error, set }) =>
				handleAppError({
					code,
					error,
					set,
					logger,
				}),
			)
			.post("/value", ({ body }) => body, {
				body: t.Object({
					value: t.Number(),
				}),
			});

		const response = await app.handle(
			new Request("http://localhost/value", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{",
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "Bad Request",
		});
		expect(logger.error).not.toHaveBeenCalled();
	});

	test("preserves explicit non-500 statuses from downstream handlers", () => {
		const logger = createLogger();
		const set = { status: 409 };

		const response = handleAppError({
			code: "UNKNOWN",
			error: new Error("Conflict"),
			set,
			logger,
		});

		expect(set.status).toBe(409);
		expect(response).toEqual({ error: "Conflict" });
		expect(logger.error).not.toHaveBeenCalled();
	});

	test("preserves explicit numeric string statuses from downstream handlers", () => {
		const logger = createLogger();
		const set: { status?: number | string } = { status: "409" };

		const response = handleAppError({
			code: "UNKNOWN",
			error: new Error("Conflict"),
			set,
			logger,
		});

		expect(set.status).toBe(409);
		expect(response).toEqual({ error: "Conflict" });
		expect(logger.error).not.toHaveBeenCalled();
	});

	test("does not expose raw internal error messages for 500 responses", () => {
		const logger = createLogger();
		const set: { status?: number | string } = {};

		const response = handleAppError({
			code: "UNKNOWN",
			error: new Error("database password token leaked in stack context"),
			set,
			logger,
		});

		expect(set.status).toBe(500);
		expect(response).toEqual({ error: "Internal Server Error" });
		expect(logger.error).toHaveBeenCalledWith(
			"[App] database password token leaked in stack context",
		);
	});
});

import { describe, expect, mock, test } from "bun:test";
import { Elysia, t } from "elysia";
import { rateLimit } from "elysia-rate-limit";
import { handleAppError } from "../errorHandling.js";
import type { LoggerLike } from "../types.js";

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
			.onError(({ code, error, status }) => {
				const response = handleAppError({
					code,
					error,
					logger,
				});
				return status(response.status, response.body);
			})
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
			.onError(({ code, error, status }) => {
				const response = handleAppError({
					code,
					error,
					logger,
				});
				return status(response.status, response.body);
			})
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

	test("does not expose raw internal error messages for 500 responses", async () => {
		const logger = createLogger();
		const app = new Elysia()
			.onError(({ code, error, status }) => {
				const response = handleAppError({ code, error, logger });
				return status(response.status, response.body);
			})
			.get("/failure", () => {
				throw new Error("database password token leaked in stack context");
			});
		const response = await app.handle(new Request("http://localhost/failure"));

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal Server Error" });
		expect(logger.error).toHaveBeenCalledWith(
			"[App] database password token leaked in stack context",
		);
	});

	test("does not let status-shaped internal errors claim HTTP response authority", async () => {
		const logger = createLogger();
		const app = new Elysia()
			.onError(({ code, error, status }) => {
				const response = handleAppError({ code, error, logger });
				return status(response.status, response.body);
			})
			.get("/failure", () => {
				throw Object.assign(new Error("private upstream rejection"), { status: 400 });
			});
		const response = await app.handle(new Request("http://localhost/failure"));

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal Server Error" });
		expect(logger.error).toHaveBeenCalledWith("[App] private upstream rejection");
	});

	test("does not let status-shaped errors claim missing-route rate-limit semantics", async () => {
		const logger = createLogger();
		const app = new Elysia()
			.use(
				rateLimit({
					max: 1,
					generator: () => "error-contract-client",
				}),
			)
			.onError(({ code, error, status }) => {
				const response = handleAppError({ code, error, logger });
				return status(response.status, response.body);
			})
			.get("/failure", () => {
				throw Object.assign(new Error("private upstream rejection"), { status: 404 });
			})
			.get("/ok", () => "ok");

		const failure = await app.handle(new Request("http://localhost/failure"));
		expect(failure.status).toBe(500);

		const success = await app.handle(new Request("http://localhost/ok"));
		expect(success.status).toBe(200);
		expect(await success.text()).toBe("ok");
	});
});

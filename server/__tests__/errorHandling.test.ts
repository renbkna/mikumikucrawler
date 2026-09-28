import { describe, expect, mock, test } from "bun:test";
import { Elysia, t } from "elysia";
import type { Logger } from "../config/logging.js";
import { handleAppError } from "../errorHandling.js";

function createLogger(): Pick<Logger, "error"> & { error: ReturnType<typeof mock> } {
	return { error: mock(() => undefined) } as unknown as Pick<Logger, "error"> & {
		error: ReturnType<typeof mock>;
	};
}

describe("app error handling", () => {
	test("preserves validation errors as 422 responses", async () => {
		const logger = createLogger();
		const app = new Elysia()
			.error(({ error, status }) => {
				const response = handleAppError({
					error,
					logger,
				});
				return status(response.status, response.body);
			})
			.post(
				"/value",
				{
					body: t.Object({
						value: t.Number(),
					}),
				},
				({ body }) => body,
			);

		const response = await app.handle(
			new Request("http://localhost/value", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ value: "wrong" }),
			}),
		);

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: "must be number",
			details: [{ path: "/value", message: "must be number" }],
		});
		expect(logger.error).not.toHaveBeenCalled();
	});

	test("treats response-schema violations as internal failures", async () => {
		const logger = createLogger();
		const app = new Elysia()
			.error(({ error, status }) => {
				const response = handleAppError({ error, logger });
				return status(response.status, response.body);
			})
			.get(
				"/invalid-response",
				{ response: { 200: t.Object({ value: t.Number() }) } },
				() => ({ value: "private invalid state" }) as never,
			);

		const response = await app.handle(new Request("http://localhost/invalid-response"));

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal Server Error" });
		expect(logger.error).toHaveBeenCalledTimes(1);
	});

	test("preserves parse errors as 400 responses", async () => {
		const logger = createLogger();
		const app = new Elysia()
			.error(({ error, status }) => {
				const response = handleAppError({
					error,
					logger,
				});
				return status(response.status, response.body);
			})
			.post(
				"/value",
				{
					body: t.Object({
						value: t.Number(),
					}),
				},
				({ body }) => body,
			);

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
			.error(({ error, status }) => {
				const response = handleAppError({ error, logger });
				return status(response.status, response.body);
			})
			.get("/failure", () => {
				throw new Error("database password token leaked in stack context");
			});
		const response = await app.handle(new Request("http://localhost/failure"));

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal Server Error" });
		expect(logger.error).toHaveBeenCalledWith(
			{
				err: expect.objectContaining({
					message: "database password token leaked in stack context",
				}),
			},
			"unhandled request error",
		);
	});

	test("does not let status-shaped internal errors claim HTTP response authority", async () => {
		const logger = createLogger();
		const app = new Elysia()
			.error(({ error, status }) => {
				const response = handleAppError({ error, logger });
				return status(response.status, response.body);
			})
			.get("/failure", () => {
				throw Object.assign(new Error("private upstream rejection"), { status: 400 });
			});
		const response = await app.handle(new Request("http://localhost/failure"));

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal Server Error" });
		expect(logger.error).toHaveBeenCalledWith(
			{ err: expect.objectContaining({ message: "private upstream rejection" }) },
			"unhandled request error",
		);
	});
});

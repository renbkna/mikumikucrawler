import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { rateLimitPlugin } from "../rateLimit.js";

function createLimitedApp(clock: { nowMs: number }) {
	return new Elysia()
		.use(
			rateLimitPlugin({
				max: 3,
				windowMs: 10_000,
				maxClients: 10,
				clientKey: (request) => request.headers.get("x-client") ?? "anonymous",
				isExempt: (request) => new URL(request.url).pathname === "/health",
				now: () => clock.nowMs,
			}),
		)
		.get("/work", () => "ok")
		.post("/work", ({ body }) => body)
		.get("/health", () => "ok");
}

const request = (path: string, client = "a") =>
	new Request(`http://localhost${path}`, { headers: { "x-client": client } });

const malformedBody = (client: string) =>
	new Request("http://localhost/work", {
		method: "POST",
		headers: { "x-client": client, "content-type": "application/json" },
		body: "{",
	});

test("admits a fixed number of requests per client window, then rejects with the API error shape", async () => {
	const clock = { nowMs: 0 };
	const app = createLimitedApp(clock);

	expect((await app.handle(request("/work"))).status).toBe(200);
	// An unknown route spends exactly one admission.
	expect((await app.handle(request("/unknown-route"))).status).toBe(404);
	expect((await app.handle(request("/work"))).status).toBe(200);
	clock.nowMs = 2_500;
	const rejected = await app.handle(request("/work"));
	expect(rejected.status).toBe(429);
	expect(rejected.headers.get("retry-after")).toBe("8");
	expect(await rejected.json()).toEqual({ error: "Too many requests", code: "RATE_LIMITED" });
	// Admission is decided before the body is parsed, so a malformed body is limited, not a 400.
	expect((await app.handle(malformedBody("a"))).status).toBe(429);
	expect((await app.handle(malformedBody("c"))).status).toBe(400);

	expect((await app.handle(request("/work", "b"))).status).toBe(200);
	expect((await app.handle(request("/health"))).status).toBe(200);

	clock.nowMs = 10_000;
	expect((await app.handle(request("/work"))).status).toBe(200);
});

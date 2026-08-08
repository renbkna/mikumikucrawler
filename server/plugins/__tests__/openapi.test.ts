import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { t } from "elysia/type-system";
import { CrawlStatusSchema } from "../../../shared/contracts/schemas.js";
import { openapiPlugin } from "../openapi.js";

test("production OpenAPI exposes the local specification without a remote interactive script", async () => {
	const app = new Elysia({ introspect: true })
		.get("/ping", { query: t.Object({ status: CrawlStatusSchema }) }, () => "pong")
		.use(openapiPlugin({ interactive: false }));

	const interactive = await app.handle(new Request("http://localhost/openapi"));
	const specification = await app.handle(new Request("http://localhost/openapi/json"));

	expect(interactive.status).toBe(404);
	expect(specification.status).toBe(200);
	expect(specification.headers.get("content-type")).toContain("application/json");
	const document = await specification.json();
	expect(document.paths).toHaveProperty("/ping");
	expect(JSON.stringify(document)).not.toContain("~elyTyp");
});

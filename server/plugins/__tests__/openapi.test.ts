import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
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

test("patched OpenAPI declarations use resolvable public package imports", async () => {
	const declarations = await Promise.all(
		["types.d.ts", "openapi.d.ts", "scalar/index.d.ts", "swagger/index.d.ts"].map((file) =>
			readFile(
				new URL(`../../../node_modules/@elysia/openapi/dist/${file}`, import.meta.url),
				"utf8",
			),
		),
	);

	const source = declarations.join("\n");
	expect(source).not.toContain("./node_modules/");
	expect(source).not.toContain("@scalar/types");
	for (const packageName of ["typebox", "openapi-types"]) {
		expect(import.meta.resolve(packageName)).toStartWith("file:");
	}
});

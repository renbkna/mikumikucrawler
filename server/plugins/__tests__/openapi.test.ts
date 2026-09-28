import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("OpenAPI declarations import only resolvable public packages", async () => {
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
	for (const packageName of ["typebox", "openapi-types", "@scalar/types"]) {
		expect(source).toContain(`from "${packageName}"`);
		expect(import.meta.resolve(packageName)).toStartWith("file:");
	}
});

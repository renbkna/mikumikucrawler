import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { spaStaticPlugin } from "../spaStatic.js";

describe("spa static plugin", () => {
	test("serves SPA navigations but returns 404 for missing asset paths", async () => {
		const distPath = mkdtempSync(path.join(tmpdir(), "miku-spa-static-"));
		writeFileSync(
			path.join(distPath, "index.html"),
			"<!doctype html><main>Miku app</main>",
		);
		try {
			const app = spaStaticPlugin({ distPath });

			const navigation = await app.handle(
				new Request("http://localhost/missing-route"),
			);
			expect(navigation.status).toBe(200);
			expect(await navigation.text()).toContain("Miku app");

			const dottedNavigation = await app.handle(
				new Request("http://localhost/reports.v2"),
			);
			expect(dottedNavigation.status).toBe(200);
			expect(await dottedNavigation.text()).toContain("Miku app");

			const apiPrefixNavigation = await app.handle(
				new Request("http://localhost/apiary"),
			);
			expect(apiPrefixNavigation.status).toBe(200);
			expect(await apiPrefixNavigation.text()).toContain("Miku app");

			const missingApiRoute = await app.handle(
				new Request("http://localhost/api/missing"),
			);
			expect(missingApiRoute.status).toBe(404);
			expect(await missingApiRoute.json()).toEqual({ error: "Not Found" });

			const missingAsset = await app.handle(
				new Request("http://localhost/missing.js"),
			);
			expect(missingAsset.status).toBe(404);
			expect(await missingAsset.json()).toEqual({ error: "Not Found" });

			const missingManifest = await app.handle(
				new Request("http://localhost/manifest-v2.json"),
			);
			expect(missingManifest.status).toBe(404);
			expect(await missingManifest.json()).toEqual({ error: "Not Found" });

			const missingRobots = await app.handle(
				new Request("http://localhost/robots.txt"),
			);
			expect(missingRobots.status).toBe(404);
			expect(await missingRobots.json()).toEqual({ error: "Not Found" });

			const missingSitemap = await app.handle(
				new Request("http://localhost/sitemap.xml"),
			);
			expect(missingSitemap.status).toBe(404);
			expect(await missingSitemap.json()).toEqual({ error: "Not Found" });
		} finally {
			rmSync(distPath, { recursive: true, force: true });
		}
	});

	test("preserves cache validators on immutable asset revalidation", async () => {
		const distPath = mkdtempSync(path.join(tmpdir(), "miku-spa-static-"));
		writeFileSync(path.join(distPath, "app.js"), "console.log('miku');");
		try {
			const app = spaStaticPlugin({ distPath });
			const first = await app.handle(new Request("http://localhost/app.js"));
			const etag = first.headers.get("etag");
			const cacheControl = first.headers.get("cache-control");

			if (!etag) {
				throw new Error("Expected immutable asset ETag");
			}

			const revalidated = await app.handle(
				new Request("http://localhost/app.js", {
					headers: { "if-none-match": etag },
				}),
			);

			expect(revalidated.status).toBe(304);
			expect(revalidated.headers.get("etag")).toBe(etag);
			expect(revalidated.headers.get("cache-control")).toBe(cacheControl);

			const wildcardRevalidated = await app.handle(
				new Request("http://localhost/app.js", {
					headers: { "if-none-match": "*" },
				}),
			);
			expect(wildcardRevalidated.status).toBe(304);
			expect(wildcardRevalidated.headers.get("etag")).toBe(etag);
			expect(wildcardRevalidated.headers.get("cache-control")).toBe(
				cacheControl,
			);

			const listedRevalidated = await app.handle(
				new Request("http://localhost/app.js", {
					headers: { "if-none-match": `"bogus", ${etag}` },
				}),
			);
			expect(listedRevalidated.status).toBe(304);
			expect(listedRevalidated.headers.get("etag")).toBe(etag);
			expect(listedRevalidated.headers.get("cache-control")).toBe(cacheControl);
		} finally {
			rmSync(distPath, { recursive: true, force: true });
		}
	});
});

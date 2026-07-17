import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spaStaticPlugin } from "../spaStatic.js";

function createDist(): string {
	const distPath = mkdtempSync(path.join(tmpdir(), "miku-spa-static-"));
	mkdirSync(path.join(distPath, "assets"));
	writeFileSync(path.join(distPath, "index.html"), "<!doctype html><main>Miku app</main>");
	return distPath;
}

describe("spa static plugin", () => {
	test("serves SPA navigations but returns 404 for missing asset paths", async () => {
		const distPath = createDist();
		try {
			const app = await spaStaticPlugin({ distPath });

			const navigation = await app.handle(new Request("http://localhost/missing-route"));
			expect(navigation.status).toBe(200);
			expect(await navigation.text()).toContain("Miku app");

			const dottedNavigation = await app.handle(new Request("http://localhost/reports.v2"));
			expect(dottedNavigation.status).toBe(200);
			expect(await dottedNavigation.text()).toContain("Miku app");

			const apiPrefixNavigation = await app.handle(new Request("http://localhost/apiary"));
			expect(apiPrefixNavigation.status).toBe(200);
			expect(await apiPrefixNavigation.text()).toContain("Miku app");

			const missingApiRoute = await app.handle(new Request("http://localhost/api/missing"));
			expect(missingApiRoute.status).toBe(404);
			expect(await missingApiRoute.json()).toEqual({ error: "Not Found" });

			const missingAsset = await app.handle(new Request("http://localhost/missing.js"));
			expect(missingAsset.status).toBe(404);
			expect(await missingAsset.json()).toEqual({ error: "Not Found" });

			const missingManifest = await app.handle(new Request("http://localhost/manifest-v2.json"));
			expect(missingManifest.status).toBe(404);
			expect(await missingManifest.json()).toEqual({ error: "Not Found" });

			const missingRobots = await app.handle(new Request("http://localhost/robots.txt"));
			expect(missingRobots.status).toBe(404);
			expect(await missingRobots.json()).toEqual({ error: "Not Found" });

			const missingSitemap = await app.handle(new Request("http://localhost/sitemap.xml"));
			expect(missingSitemap.status).toBe(404);
			expect(await missingSitemap.json()).toEqual({ error: "Not Found" });
		} finally {
			rmSync(distPath, { recursive: true, force: true });
		}
	});

	test("requires revalidation for mutable public root files", async () => {
		const distPath = createDist();
		writeFileSync(path.join(distPath, "app.js"), "console.log('miku');");
		try {
			const app = await spaStaticPlugin({ distPath });
			const first = await app.handle(new Request("http://localhost/app.js"));
			const cacheControl = first.headers.get("cache-control");
			const etag = first.headers.get("etag");

			expect(cacheControl).toBe("no-cache");
			expect(cacheControl).not.toContain("immutable");
			expect(etag).not.toBeNull();

			const revalidated = await app.handle(
				new Request("http://localhost/app.js", {
					headers: { "If-None-Match": etag ?? "" },
				}),
			);
			expect(revalidated.status).toBe(304);
		} finally {
			rmSync(distPath, { recursive: true, force: true });
		}
	});

	test("keeps API and health namespaces outside static-file ownership", async () => {
		const distPath = createDist();
		mkdirSync(path.join(distPath, "api"));
		writeFileSync(path.join(distPath, "api", "private.json"), "private static file");
		writeFileSync(path.join(distPath, "health"), "static health file");
		try {
			const app = await spaStaticPlugin({ distPath });

			for (const requestPath of ["/api/private.json", "/health"]) {
				const response = await app.handle(new Request(`http://localhost${requestPath}`));
				expect(response.status).toBe(404);
				expect(await response.json()).toEqual({ error: "Not Found" });
			}
		} finally {
			rmSync(distPath, { recursive: true, force: true });
		}
	});

	test("serves versioned assets when the build exceeds the plugin default route limit", async () => {
		const distPath = createDist();
		for (let index = 0; index < 1024; index += 1) {
			writeFileSync(path.join(distPath, "assets", `${index}.js`), String(index));
		}
		try {
			const app = await spaStaticPlugin({ distPath });
			const response = await app.handle(new Request("http://localhost/assets/0.js"));

			expect(response.status).toBe(200);
			expect(await response.text()).toBe("0");
		} finally {
			rmSync(distPath, { recursive: true, force: true });
		}
	});

	test("uses immutable caching only for versioned build assets", async () => {
		const distPath = createDist();
		writeFileSync(path.join(distPath, "assets", "index-abc123.js"), "console.log('miku');");
		try {
			const app = await spaStaticPlugin({ distPath });
			const response = await app.handle(new Request("http://localhost/assets/index-abc123.js"));

			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("immutable, max-age=31536000");
			expect(response.headers.get("etag")).toBeNull();
		} finally {
			rmSync(distPath, { recursive: true, force: true });
		}
	});

	test("never stores the SPA document or navigation fallback", async () => {
		const distPath = createDist();
		try {
			const app = await spaStaticPlugin({ distPath });

			for (const requestPath of ["/", "/index.html", "/dashboard"]) {
				const response = await app.handle(new Request(`http://localhost${requestPath}`));
				expect(response.status).toBe(200);
				expect(response.headers.get("cache-control")).toBe("no-store");
				expect(response.headers.get("content-type")).toContain("text/html");
			}
		} finally {
			rmSync(distPath, { recursive: true, force: true });
		}
	});
});

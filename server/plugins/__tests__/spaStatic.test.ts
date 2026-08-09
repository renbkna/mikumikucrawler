import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { staticPlugin } from "@elysia/static";
import { spaStaticPlugin } from "../spaStatic.js";

function createDist(): string {
	const distPath = mkdtempSync(path.join(tmpdir(), "miku-spa-static-"));
	mkdirSync(path.join(distPath, "assets"));
	writeFileSync(path.join(distPath, "index.html"), "<!doctype html><main>Miku app</main>");
	return distPath;
}

describe("spa static plugin", () => {
	test("patched dependency decodes valid paths and safely rejects malformed or escaping paths", async () => {
		const rootPath = mkdtempSync(path.join(tmpdir(), "miku-static-decoder-"));
		const assetsPath = path.join(rootPath, "assets");
		mkdirSync(path.join(assetsPath, "nested"), { recursive: true });
		writeFileSync(path.join(assetsPath, "miku song.txt"), "space");
		writeFileSync(path.join(assetsPath, "nested", "song.txt"), "nested");
		writeFileSync(path.join(rootPath, "secret.txt"), "secret");
		try {
			const app = await staticPlugin({
				assets: assetsPath,
				prefix: "/files",
				alwaysStatic: false,
				decodeURI: true,
			});

			const spaced = await app.handle(new Request("http://localhost/files/miku%20song.txt"));
			expect(spaced.status).toBe(200);
			expect(await spaced.text()).toBe("space");

			const nested = await app.handle(new Request("http://localhost/files/nested%2Fsong.txt"));
			expect(nested.status).toBe(200);
			expect(await nested.text()).toBe("nested");

			for (const requestPath of ["/files/%", "/files/%2e%2e%2fsecret.txt"]) {
				const response = await app.handle(new Request(`http://localhost${requestPath}`));
				expect(response.status).toBe(404);
			}
		} finally {
			rmSync(rootPath, { recursive: true, force: true });
		}
	});

	test("serves SPA navigations but returns 404 for missing asset paths", async () => {
		const distPath = createDist();
		try {
			const app = await spaStaticPlugin({ distPath });

			const navigation = await app.handle(
				new Request("http://localhost/missing-route", {
					headers: { Accept: "text/html" },
				}),
			);
			expect(navigation.status).toBe(200);
			expect(await navigation.text()).toContain("Miku app");

			const dottedNavigation = await app.handle(
				new Request("http://localhost/reports.v2", {
					headers: { Accept: "text/html,application/xhtml+xml" },
				}),
			);
			expect(dottedNavigation.status).toBe(200);
			expect(await dottedNavigation.text()).toContain("Miku app");

			const apiPrefixNavigation = await app.handle(
				new Request("http://localhost/apiary", {
					headers: { Accept: "text/html" },
				}),
			);
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

			for (const requestPath of [
				"/missing.webp",
				"/missing.pdf",
				"/missing.wasm",
				"/missing.mp4",
				"/missing.zip",
			]) {
				const response = await app.handle(
					new Request(`http://localhost${requestPath}`, {
						headers: { Accept: "*/*" },
					}),
				);
				expect(response.status).toBe(404);
				expect(await response.json()).toEqual({ error: "Not Found" });
			}
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

	test("keeps backend namespaces outside static-file ownership", async () => {
		const distPath = createDist();
		mkdirSync(path.join(distPath, "api"));
		mkdirSync(path.join(distPath, "openapi"));
		writeFileSync(path.join(distPath, "api", "private.json"), "private static file");
		writeFileSync(path.join(distPath, "health"), "static health file");
		writeFileSync(path.join(distPath, "openapi", "json"), "private static specification");
		try {
			const app = await spaStaticPlugin({ distPath });

			for (const requestPath of [
				"/api/private.json",
				"/api%2Fprivate.json",
				"/health",
				"/%68ealth",
				"/openapi",
				"/openapi/json",
				"/openapi%2Fjson",
				"/%6fpenapi/json",
				"/%",
			]) {
				const response = await app.handle(
					new Request(`http://localhost${requestPath}`, {
						headers: { Accept: "text/html" },
					}),
				);
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
				const response = await app.handle(
					new Request(`http://localhost${requestPath}`, {
						headers: { Accept: "text/html" },
					}),
				);
				expect(response.status).toBe(200);
				expect(response.headers.get("cache-control")).toBe("no-store");
				expect(response.headers.get("content-type")).toContain("text/html");
			}
		} finally {
			rmSync(distPath, { recursive: true, force: true });
		}
	});
});

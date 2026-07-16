import { describe, expect, mock, test } from "bun:test";
import { resolveChromiumExecutable } from "../browser.js";

describe("Chromium executable resolution", () => {
	test("an explicit executable is authoritative and an invalid override cannot silently fall back", () => {
		const findExecutable = mock(() => "/usr/bin/chromium");

		expect(
			resolveChromiumExecutable("/custom/chrome", "/managed/chrome", {
				pathExists: (path) => path === "/custom/chrome",
				findExecutable,
			}),
		).toEqual({ source: "configured", executablePath: "/custom/chrome" });
		expect(
			resolveChromiumExecutable("/missing/chrome", "/managed/chrome", {
				pathExists: () => false,
				findExecutable,
			}),
		).toEqual({ source: "invalid-configured", executablePath: "/missing/chrome" });
		expect(findExecutable).not.toHaveBeenCalled();
	});

	test("the Playwright-managed browser remains preferred when installed", () => {
		const findExecutable = mock(() => "/usr/bin/chromium");

		expect(
			resolveChromiumExecutable(undefined, "/managed/chrome", {
				pathExists: (path) => path === "/managed/chrome",
				findExecutable,
			}),
		).toEqual({ source: "playwright" });
		expect(findExecutable).not.toHaveBeenCalled();
	});

	test("a named system browser is a bounded fallback when Playwright is absent", () => {
		const available = new Map([["chromium-browser", "/usr/bin/chromium-browser"]]);
		const dependencies = {
			pathExists: () => false,
			findExecutable: (command: string) => available.get(command) ?? null,
		};

		expect(resolveChromiumExecutable(undefined, "/missing/managed", dependencies)).toEqual({
			source: "system",
			executablePath: "/usr/bin/chromium-browser",
		});
		expect(
			resolveChromiumExecutable(undefined, "/missing/managed", {
				...dependencies,
				findExecutable: () => null,
			}),
		).toEqual({ source: "missing" });
	});
});

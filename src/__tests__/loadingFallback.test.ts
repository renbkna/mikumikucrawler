import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const loadingFallbackSource = await readFile(
	new URL("../../public/loading-fallback.js", import.meta.url),
	"utf8",
);
const indexSource = await readFile(new URL("../../index.html", import.meta.url), "utf8");

function runLoadingFallback(applicationReady = false) {
	const title = { textContent: "Miku Miku Crawler" };
	const status = { textContent: "LOADING..." };
	let retryClick: (() => void) | undefined;
	const retry = {
		hidden: true,
		addEventListener: (_type: string, listener: () => void) => {
			retryClick = listener;
		},
	};
	const state = { lookups: 0, reloads: 0 };
	const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
	const elements: Record<string, object> = {
		"loading-retry": retry,
		"loading-screen": {},
		"loading-status": status,
		"loading-title": title,
	};

	runInNewContext(loadingFallbackSource, {
		document: {
			documentElement: { dataset: applicationReady ? { applicationReady: "true" } : {} },
			getElementById: (id: string) => {
				state.lookups += 1;
				return elements[id] ?? null;
			},
		},
		setTimeout: (callback: () => void, delayMs: number) => scheduled.push({ callback, delayMs }),
		window: { location: { reload: () => (state.reloads += 1) } },
	});

	return { retry, retryClick: () => retryClick?.(), scheduled, state, status, title };
}

describe("loading fallback", () => {
	test("the document loads the fallback as a CSP-safe independent script", () => {
		expect(indexSource).toContain('<script src="/loading-fallback.js"></script>');
		expect(indexSource).not.toContain("upgrade-insecure-requests");
		const inlineScriptBodies = [
			...indexSource.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g),
		]
			.map((match) => match[1]?.trim() ?? "")
			.filter(Boolean);
		expect(inlineScriptBodies).toEqual([]);
	});

	test("the independently shipped script exposes failure and retry without declaring readiness", () => {
		const fallback = runLoadingFallback();

		expect(fallback.scheduled.map(({ delayMs }) => delayMs)).toEqual([8000]);
		fallback.scheduled[0].callback();
		expect(fallback.title.textContent).toBe("Application failed to start");
		expect(fallback.status.textContent).toBe("The application bundle did not load.");
		expect(fallback.retry.hidden).toBe(false);
		fallback.retryClick();
		expect(fallback.state.reloads).toBe(1);
	});

	test("does nothing after React has declared the application ready", () => {
		const fallback = runLoadingFallback(true);

		fallback.scheduled[0].callback();
		expect(fallback.state.lookups).toBe(0);
		expect(fallback.scheduled).toHaveLength(1);
	});
});

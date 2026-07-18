import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const loadingFallbackSource = await readFile(
	new URL("../../public/loading-fallback.js", import.meta.url),
	"utf8",
);
const indexSource = await readFile(new URL("../../index.html", import.meta.url), "utf8");

describe("loading fallback", () => {
	test("the document loads the fallback as a CSP-safe independent script", () => {
		expect(indexSource).toContain('<script src="/loading-fallback.js"></script>');
		const inlineScriptBodies = [
			...indexSource.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g),
		]
			.map((match) => match[1]?.trim() ?? "")
			.filter(Boolean);
		expect(inlineScriptBodies).toEqual([]);
	});

	test("the independently shipped script hides the loading screen after a bounded delay", () => {
		const style = { display: "flex", opacity: "1", transition: "" };
		const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
		runInNewContext(loadingFallbackSource, {
			document: { getElementById: () => ({ style }) },
			setTimeout: (callback: () => void, delayMs: number) => scheduled.push({ callback, delayMs }),
		});

		expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([3000]);
		scheduled[0].callback();
		expect(style).toEqual({
			display: "flex",
			opacity: "0",
			transition: "opacity 500ms ease-in-out",
		});
		expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([3000, 500]);
		scheduled[1].callback();
		expect(style.display).toBe("none");
	});

	test("does nothing after React has removed the loading screen", () => {
		const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
		runInNewContext(loadingFallbackSource, {
			document: { getElementById: () => null },
			setTimeout: (callback: () => void, delayMs: number) => scheduled.push({ callback, delayMs }),
		});

		scheduled[0].callback();
		expect(scheduled).toHaveLength(1);
	});
});

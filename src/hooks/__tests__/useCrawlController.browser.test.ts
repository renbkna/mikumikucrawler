import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { resolveChromiumExecutable } from "../../../server/config/browser.js";

// Mount real React effects; only the controller's network boundary is replaced.
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {useCrawlController} from ${JSON.stringify(new URL("../useCrawlController.ts", import.meta.url).pathname)};
const addToast = () => {};
window.calls = [];
window.savedPages = 0;
window.hold = false;
window.emit = (type, payload) => window.handlers.onEvent({
  type, payload, crawlId: window.c.activeCrawlId,
  sequence: ++window.run.eventSequence, timestamp: new Date().toISOString()
});
window.savePage = () => {
  const id = ++window.savedPages;
  window.emit('crawl.page', {id, url: 'https://example.com/' + id,
    title: 'needle', domain: 'example.com', details: {}, pageCount: id});
};
function Probe() {
  window.c = useCrawlController({addToast});
  return null;
}
window.root = createRoot(document.getElementById('root'));
window.root.render(React.createElement(Probe));
`;

const network = `
export async function createCrawl(id, options) {
  window.run = {id, options, target: options.target, status: 'running', eventSequence: 0,
    counters: {pagesScanned: 0, successCount: 0, failureCount: 0, skippedCount: 0,
      linksFound: 0, mediaFiles: 0, totalDataKb: 0}};
  return {ok: true, data: window.run};
}
export async function getCrawlRecoverySnapshot() {
  return {ok: true, data: {crawl: window.run, pages: [], pageCount: window.savedPages}};
}
export async function listResumableCrawls() {return {ok: true, data: []};}
export function subscribeToCrawlEvents(id, handlers) {window.handlers = handlers; return {close() {}};}
export async function deleteCrawl() {return {ok: true};}
export function downloadCrawlExport() {throw new Error('Unexpected export');}
export function resumeCrawl() {throw new Error('Unexpected resume');}
export function stopCrawl() {throw new Error('Unexpected stop');}
export async function searchStoredPages(id, query, signal) {
  const count = query === 'needle' ? window.savedPages : 0;
  const result = {ok: true, data: {count, pages: Array.from({length: count}, (_, i) => ({
    id: i + 1, url: 'https://example.com/' + (i + 1), title: 'needle', details: {}
  }))}};
  const call = {signal, query};
  window.calls.push(call);
  // Deliberately allow late responses after abort to exercise the consumer's identity guard.
  if (window.hold) await new Promise(resolve => {call.release = resolve;});
  return result;
}
`;

test("mounted search follows durable revisions and isolates superseded requests", async () => {
	const build = await Bun.build({
		entrypoints: ["controller-probe"],
		target: "browser",
		plugins: [
			{
				name: "controller-probe",
				setup(builder) {
					builder.onResolve({ filter: /^controller-probe$/ }, () => ({
						path: "entry",
						namespace: "probe",
					}));
					builder.onLoad({ filter: /^entry$/, namespace: "probe" }, () => ({
						contents: entry,
						loader: "js",
						resolveDir: new URL("..", import.meta.url).pathname,
					}));
					builder.onResolve({ filter: /\.\.\/api\/(crawls|search)$/ }, (args) =>
						args.importer.endsWith("/hooks/useCrawlController.ts")
							? { path: "network", namespace: "probe" }
							: undefined,
					);
					builder.onLoad({ filter: /^network$/, namespace: "probe" }, () => ({
						contents: network,
						loader: "js",
					}));
				},
			},
		],
	});
	if (!build.success) throw new AggregateError(build.logs, "Browser probe build failed");
	const executable = resolveChromiumExecutable(
		process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		chromium.executablePath(),
	);
	if (executable.source === "missing" || executable.source === "invalid-configured") {
		throw new Error(
			"Controller browser proof requires Chromium; run bunx playwright install chromium or configure PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
		);
	}
	const browser = await chromium.launch({
		headless: true,
		...(executable.source === "playwright" ? {} : { executablePath: executable.executablePath }),
	});
	try {
		const page = await browser.newPage();
		page.setDefaultTimeout(5_000);
		await page.route("http://localhost/**", (route) =>
			route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
		);
		await page.goto("http://localhost/");
		await page.addScriptTag({ content: await build.outputs[0].text(), type: "module" });
		await page.waitForFunction("!!window.c");
		await page.evaluate("c.handleTargetChange('https://example.com/')");
		await page.waitForFunction("c.target === 'https://example.com/'");
		await page.evaluate("c.startCrawl()");
		await page.waitForFunction("!!c.activeCrawlId && !!window.handlers");
		await page.evaluate("c.setSearchQuery('needle')");
		await page.waitForFunction("calls.length === 1 && !c.isSearchingPages");
		expect(await page.evaluate<number>("c.searchResultCount")).toBe(0);

		await page.evaluate("savePage()");
		await page.waitForFunction("c.searchResultCount === 1 && !c.isSearchingPages");

		// Recovery can discover durable pages for which no live page event arrived.
		await page.evaluate("savedPages = 2; handlers.onError()");
		await page.waitForFunction(
			"c.storedPageCount === 2 && c.searchResultCount === 2 && !c.isSearchingPages",
		);

		// A burst during a slow request queues a refresh without starving that request.
		await page.evaluate("hold = true; savePage()");
		await page.waitForFunction("!!calls.at(-1).release");
		const beforeBurst = await page.evaluate<number>("calls.length");
		await page.evaluate("window.pending = calls.at(-1); savePage(); savePage()");
		await page.waitForFunction("c.storedPageCount === 5");
		expect(await page.evaluate<boolean>("pending.signal.aborted")).toBe(false);
		await page.evaluate("hold = false; pending.release()");
		await page.waitForFunction("c.searchResultCount === 5 && !c.isSearchingPages");
		expect(await page.evaluate<number>("calls.length")).toBe(beforeBurst + 1);

		// Terminal phase invalidates even when the durable page count is unchanged.
		await page.evaluate(
			"window.beforeCompletion = calls.length; emit('crawl.completed', {counters: run.counters})",
		);
		await page.waitForFunction(
			"c.runPhase === 'completed' && calls.length > beforeCompletion && !c.isSearchingPages",
		);

		await page.evaluate("hold = true; c.setSearchQuery('missing')");
		await page.waitForFunction("calls.at(-1).query === 'missing' && !!calls.at(-1).release");
		await page.evaluate("window.obsolete = calls.at(-1); hold = false; c.setSearchQuery('needle')");
		await page.waitForFunction("c.searchResultCount === 5 && !c.isSearchingPages");
		expect(await page.evaluate<boolean>("obsolete.signal.aborted")).toBe(true);
		await page.evaluate("obsolete.release()");
		// Let promise handlers and React paint before checking that the late result was ignored.
		await page.evaluate(
			"new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
		);
		expect(await page.evaluate<number>("c.searchResultCount")).toBe(5);

		await page.evaluate("hold = true; c.setSearchQuery('unmount')");
		await page.waitForFunction("calls.at(-1).query === 'unmount' && !!calls.at(-1).release");
		await page.evaluate("root.unmount()");
		expect(await page.evaluate<boolean>("calls.at(-1).signal.aborted")).toBe(true);
		await page.evaluate("calls.at(-1).release()");
	} finally {
		await browser.close();
	}
}, 20_000);

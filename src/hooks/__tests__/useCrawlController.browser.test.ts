import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright";
import { resolveChromiumExecutable } from "../../../server/config/browser.js";

// Mount real React effects; only the controller's network boundary is replaced.
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {useCrawlController} from ${JSON.stringify(new URL("../useCrawlController.ts", import.meta.url).pathname)};
window.toasts = [];
const addToast = (type, message) => window.toasts.push({type, message});
window.calls = [];
window.savedPages = 0;
window.hold = false;
window.snapshotCalls = [];
window.holdSnapshot = false;
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
export async function getCrawlRecoverySnapshot(id, signal) {
  const call = {signal};
  window.snapshotCalls.push(call);
  const snapshot = {crawl: structuredClone(window.run), pages: [], pageCount: window.savedPages};
  if (window.holdSnapshot) await new Promise(resolve => {call.release = resolve;});
  return {ok: true, data: snapshot};
}
export async function listResumableCrawls() {return {ok: true, data: []};}
export function subscribeToCrawlEvents(id, handlers) {window.handlers = handlers; return {close() {}};}
export async function deleteCrawl() {return {ok: true};}
export function downloadCrawlExport() {throw new Error('Unexpected export');}
export async function resumeCrawl(id, signal) {
  window.run.status = 'running';
  return getCrawlRecoverySnapshot(id, signal);
}
export async function stopCrawl(id, mode, signal) {
  if (!window.failStop) throw new Error('Unexpected stop');
  window.run.status = mode === 'force' ? 'stopped' : 'paused';
  window.run.eventSequence += 1;
  throw new Error('Stop response lost');
}
export async function searchStoredPages(id, query, signal) {
  const count = query === 'needle' ? window.savedPages : 0;
  const result = {ok: true, data: {count, results: Array.from({length: count}, (_, i) => ({
    id: i + 1, url: 'https://example.com/' + (i + 1), title: 'needle', description: '',
    domain: 'example.com', snippet: 'needle'
  }))}};
  const call = {signal, query};
  window.calls.push(call);
  // Deliberately allow late responses after abort to exercise the consumer's identity guard.
  if (window.hold) await new Promise(resolve => {call.release = resolve;});
  return result;
}
`;

async function withController(run: (page: Page) => Promise<void>): Promise<void> {
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
					// Replace the API modules regardless of which hook requests the capability.
					builder.onLoad({ filter: /\/src\/api\/(crawls|search)\.ts$/ }, () => ({
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
		await run(page);
	} finally {
		await browser.close();
	}
}

test("mounted search follows durable revisions and isolates superseded requests", async () => {
	await withController(async (page) => {
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

		// A terminal delivery gap still finishes recovery after closing its stream.
		await page.evaluate("holdSnapshot = true; handlers.onInvalidEvent()");
		await page.waitForFunction("!!snapshotCalls.at(-1).release");
		await page.evaluate(
			"window.finalRecovery = snapshotCalls.at(-1); window.beforeCompletion = calls.length; savedPages = 6; run.eventSequence += 1; emit('crawl.completed', {counters: run.counters})",
		);
		expect(await page.evaluate<boolean>("finalRecovery.signal.aborted")).toBe(false);
		// The phase alone invalidates search before recovery changes the stored count.
		await page.waitForFunction(
			"c.runPhase === 'completed' && c.storedPageCount === 5 && calls.length > beforeCompletion && !c.isSearchingPages",
		);
		await page.evaluate("holdSnapshot = false; finalRecovery.release()");
		await page.waitForFunction(
			"c.runPhase === 'completed' && c.storedPageCount === 6 && c.searchResultCount === 6 && calls.length > beforeCompletion && !c.isSearchingPages",
		);

		await page.evaluate("hold = true; c.setSearchQuery('missing')");
		await page.waitForFunction("calls.at(-1).query === 'missing' && !!calls.at(-1).release");
		await page.evaluate("window.obsolete = calls.at(-1); hold = false; c.setSearchQuery('needle')");
		await page.waitForFunction("c.searchResultCount === 6 && !c.isSearchingPages");
		expect(await page.evaluate<boolean>("obsolete.signal.aborted")).toBe(true);
		await page.evaluate("obsolete.release()");
		// Let promise handlers and React paint before checking that the late result was ignored.
		await page.evaluate(
			"new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
		);
		expect(await page.evaluate<number>("c.searchResultCount")).toBe(6);

		await page.evaluate("hold = true; c.setSearchQuery('unmount')");
		await page.waitForFunction("calls.at(-1).query === 'unmount' && !!calls.at(-1).release");
		await page.evaluate("root.unmount()");
		expect(await page.evaluate<boolean>("calls.at(-1).signal.aborted")).toBe(true);
		await page.evaluate("calls.at(-1).release()");
	});
}, 20_000);

test("live recovery coalesces requests and retires callbacks across same-crawl resume and unmount", async () => {
	await withController(async (page) => {
		await page.evaluate("c.handleTargetChange('https://example.com/')");
		await page.waitForFunction("c.target === 'https://example.com/'");
		await page.evaluate("c.startCrawl()");
		await page.waitForFunction(
			"!!c.activeCrawlId && !!window.handlers && snapshotCalls.length === 1",
		);
		// Repeated delivery gaps must not starve a snapshot already being fetched.
		await page.evaluate("holdSnapshot = true; handlers.onInvalidEvent()");
		await page.waitForFunction("!!snapshotCalls.at(-1).release");
		await page.evaluate(
			"window.recovery = snapshotCalls.at(-1); window.beforeRecoveryBurst = snapshotCalls.length; handlers.onInvalidEvent(); handlers.onError()",
		);
		expect(await page.evaluate<boolean>("recovery.signal.aborted")).toBe(false);
		expect(await page.evaluate<boolean>("snapshotCalls.length === beforeRecoveryBurst")).toBe(true);
		await page.evaluate("holdSnapshot = false; recovery.release()");
		await page.waitForFunction("snapshotCalls.length === beforeRecoveryBurst + 1");

		await page.evaluate(
			"window.retired = handlers; run.status = 'paused'; emit('crawl.paused', {counters: run.counters, stopReason: 'Paused'})",
		);
		await page.waitForFunction("c.runPhase === 'paused'");
		await page.evaluate("c.resumeCrawl(c.activeCrawlId)");
		await page.waitForFunction("handlers !== retired && c.runPhase === 'running'");
		// Events published before the stream opened are recovered from a snapshot read after it.
		await page.evaluate("window.beforeOpen = snapshotCalls.length; handlers.onOpen()");
		await page.waitForFunction(
			"c.connectionState === 'connected' && snapshotCalls.length > beforeOpen",
		);
		await page.evaluate(`
   window.beforeRetired = snapshotCalls.length;
   retired.onError(); retired.onOpen(); retired.onInvalidEvent();
   retired.onEvent({type: 'crawl.log', crawlId: c.activeCrawlId,
    sequence: run.eventSequence + 100, timestamp: new Date().toISOString(),
    payload: {message: 'obsolete stream', level: 'error'}});
  `);
		await page.evaluate(
			"new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
		);
		expect(
			await page.evaluate<boolean>(
				"c.connectionState === 'connected' && snapshotCalls.length === beforeRetired && !c.logs.some(log => log.message === 'obsolete stream')",
			),
		).toBe(true);

		await page.evaluate("holdSnapshot = true; handlers.onInvalidEvent()");
		await page.waitForFunction("!!snapshotCalls.at(-1).release");
		await page.evaluate("window.unmounted = snapshotCalls.at(-1); root.unmount()");
		expect(await page.evaluate<boolean>("unmounted.signal.aborted")).toBe(true);
		await page.evaluate("unmounted.release(); handlers.onError()");
	});
}, 20_000);

test("thrown stop responses reconcile the durable outcome before reporting failure", async () => {
	for (const [command, expected] of [
		["pauseCrawl", "paused"],
		["forceStopCrawl", "stopped"],
	]) {
		await withController(async (page) => {
			await page.evaluate("c.handleTargetChange('https://example.com/')");
			await page.waitForFunction("c.target === 'https://example.com/'");
			await page.evaluate("c.startCrawl()");
			await page.waitForFunction("c.runPhase === 'running' && snapshotCalls.length === 1");
			await page.evaluate("window.failStop = true; toasts.length = 0");
			await page.evaluate(`c.${command}()`);
			await page.evaluate(
				"new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
			);
			expect(await page.evaluate<string>("c.runPhase")).toBe(expected);
			expect(await page.evaluate<number>("snapshotCalls.length")).toBe(2);
			expect(await page.evaluate<boolean>("toasts.some(toast => toast.type === 'error')")).toBe(
				false,
			);
		});
	}
}, 20_000);

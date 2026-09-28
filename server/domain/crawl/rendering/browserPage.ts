import type { Page } from "playwright";
import { DYNAMIC_RENDERER_CONSTANTS, REQUEST_CONSTANTS } from "../../../constants.js";
import { onAbort, raceAbort } from "../../../utils/abort.js";
import { OperationTimeoutError, runWithTimeout } from "../../../utils/timeout.js";

export const MAX_RENDERED_DOM_NODES = 50_000;

export interface RenderedSnapshot {
	content: string;
	description: string;
	effectiveUrl: string;
	title: string;
}

/** Playwright reports these conditions only through error text; this is the one place that reads it. */
const CLOSED_TARGET_MARKER = "Target page, context or browser has been closed";
const TRANSIENT_BROWSER_MARKERS = [
	CLOSED_TARGET_MARKER,
	"Navigation failed because page crashed",
	"net::ERR_ABORTED",
	"Execution context was destroyed",
	"Frame was detached",
];

function messageIncludesAny(error: unknown, markers: readonly string[]): boolean {
	return error instanceof Error && markers.some((marker) => error.message.includes(marker));
}

/** True when the page, context, or browser was already closed. */
export function isClosedBrowserTargetError(error: unknown): boolean {
	return messageIncludesAny(error, [CLOSED_TARGET_MARKER, "Page closed"]);
}

/** True when a browser step failed in a way a static fallback or retry can recover from. */
export function isRecoverableBrowserError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (err instanceof OperationTimeoutError || err.name === "TimeoutError") return true;
	return messageIncludesAny(err, TRANSIENT_BROWSER_MARKERS);
}

export function readBoundedDocumentText(options: {
	maxChars: number;
	maxNodes: number;
	visibleOnly: boolean;
}): string {
	const body = document.body;
	if (!body) return "";

	const walker = document.createTreeWalker(body, NodeFilter.SHOW_ALL);
	let text = "";
	let visitedNodes = 0;
	while (walker.nextNode()) {
		visitedNodes += 1;
		if (visitedNodes > options.maxNodes || text.length >= options.maxChars) break;
		const node = walker.currentNode;
		if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue) continue;
		if (options.visibleOnly) {
			const parent = node.parentElement;
			if (!parent || parent.hidden || parent.getClientRects().length === 0) continue;
			const style = getComputedStyle(parent);
			if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
				continue;
			}
		}
		if (text.length > 0) text += " ";
		text += node.nodeValue.slice(0, options.maxChars - text.length);
	}
	return text;
}

export async function openBrowserPageWithRetry(
	createPage: () => Promise<Page>,
	onRetry: (error: unknown) => void,
	signal?: AbortSignal,
	ownership?: { isCurrent(): boolean; close(page: Page): Promise<void> },
): Promise<Page> {
	const accept = async (page: Page): Promise<Page> => {
		if (!signal?.aborted && (ownership?.isCurrent() ?? true)) return page;
		await ownership?.close(page);
		signal?.throwIfAborted();
		throw new Error("Browser page acquisition completed after renderer ownership ended");
	};
	const acquire = () => raceAbort(createPage().then(accept), signal);
	try {
		return await acquire();
	} catch (error) {
		signal?.throwIfAborted();
		if (!isRecoverableBrowserError(error)) throw error;
		onRetry(error);
		return acquire();
	}
}

export async function runPageOperationWithDeadline<T>(options: {
	page: Page;
	timeoutMs: number;
	operationName: string;
	signal?: AbortSignal;
	run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
	let closePromise: Promise<void> | undefined;
	const closePage = () => {
		closePromise ??= options.page.close({ runBeforeUnload: false }).catch(() => undefined);
	};

	return runWithTimeout({
		timeoutMs: options.timeoutMs,
		operationName: options.operationName,
		...(options.signal ? { signal: options.signal } : {}),
		run: async (operationSignal) => {
			try {
				using _closeOnAbort = onAbort(operationSignal, closePage);
				operationSignal.throwIfAborted();
				// Closing the page releases everything the operation holds, but Playwright may
				// never settle a call into a frame that has no document; the close is the settlement.
				return await raceAbort(options.run(operationSignal), operationSignal);
			} finally {
				await closePromise;
			}
		},
	});
}

export async function extractRenderedSnapshot(
	page: Page,
	signal?: AbortSignal,
): Promise<RenderedSnapshot | "tooLarge"> {
	return runPageOperationWithDeadline({
		page,
		timeoutMs: DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.SNAPSHOT,
		operationName: "Rendered document snapshot",
		...(signal ? { signal } : {}),
		run: () =>
			page.evaluate(
				({ maxBytes, maxNodes }) => {
					const root = document.documentElement;
					if (!root) {
						return {
							content: "",
							description: "",
							effectiveUrl: window.location.href,
							title: document.title || "",
						};
					}
					let upperBound = 0;
					let visitedNodes = 0;
					const addSerializedText = (value: string, attribute = false) => {
						for (let index = 0; index < value.length; index++) {
							const codeUnit = value.charCodeAt(index);
							if (codeUnit <= 0x7f) {
								upperBound +=
									codeUnit === 0x26
										? 5
										: codeUnit === 0x3c || codeUnit === 0x3e
											? 4
											: attribute && codeUnit === 0x22
												? 6
												: 1;
							} else if (codeUnit <= 0x7ff) {
								upperBound += 2;
							} else if (
								codeUnit >= 0xd800 &&
								codeUnit <= 0xdbff &&
								index + 1 < value.length &&
								value.charCodeAt(index + 1) >= 0xdc00 &&
								value.charCodeAt(index + 1) <= 0xdfff
							) {
								upperBound += 4;
								index += 1;
							} else {
								upperBound += 3;
							}
							if (upperBound > maxBytes) return false;
						}
						return true;
					};
					const stack: Node[] = [root];
					while (stack.length > 0) {
						const node = stack.pop();
						if (!node) break;
						visitedNodes += 1;
						if (visitedNodes > maxNodes) return "tooLarge" as const;
						if (node.nodeType === Node.ELEMENT_NODE) {
							const element = node as Element;
							upperBound += 5;
							if (!addSerializedText(element.tagName) || !addSerializedText(element.tagName)) {
								return "tooLarge" as const;
							}
							for (const attribute of element.attributes) {
								upperBound += 4;
								if (!addSerializedText(attribute.name)) return "tooLarge" as const;
								if (!addSerializedText(attribute.value, true)) return "tooLarge" as const;
							}
						} else if (node.nodeType === Node.COMMENT_NODE) {
							upperBound += 7;
							if (!addSerializedText(node.nodeValue ?? "")) return "tooLarge" as const;
						} else if (!addSerializedText(node.nodeValue ?? "")) {
							return "tooLarge" as const;
						}
						if (upperBound > maxBytes) return "tooLarge" as const;
						for (let index = node.childNodes.length - 1; index >= 0; index--) {
							const child = node.childNodes[index];
							if (child) stack.push(child);
						}
					}

					const content = root.outerHTML;
					let contentLength = 0;
					for (let index = 0; index < content.length; index++) {
						const codeUnit = content.charCodeAt(index);
						if (codeUnit <= 0x7f) {
							contentLength += 1;
						} else if (codeUnit <= 0x7ff) {
							contentLength += 2;
						} else if (
							codeUnit >= 0xd800 &&
							codeUnit <= 0xdbff &&
							index + 1 < content.length &&
							content.charCodeAt(index + 1) >= 0xdc00 &&
							content.charCodeAt(index + 1) <= 0xdfff
						) {
							contentLength += 4;
							index += 1;
						} else {
							contentLength += 3;
						}
						if (contentLength > maxBytes) return "tooLarge" as const;
					}

					return {
						content,
						description:
							document.querySelector('meta[name="description"]')?.getAttribute("content") || "",
						effectiveUrl: window.location.href,
						title: document.title || "",
					};
				},
				{
					maxBytes: REQUEST_CONSTANTS.MAX_TEXT_DOCUMENT_BYTES,
					maxNodes: MAX_RENDERED_DOM_NODES,
				},
			),
	});
}

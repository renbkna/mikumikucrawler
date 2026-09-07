import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import type { Logger } from "../../../config/logging.js";
import { DYNAMIC_RENDERER_CONSTANTS } from "../../../constants.js";
import { getErrorMessage } from "../../../utils/helpers.js";
import {
	CONSENT_ACTION_MARKERS,
	CONSENT_BUTTON_SELECTORS,
	CONSENT_NEGATIVE_ACTION_MARKERS,
	isConsentWallText,
} from "../consent.js";
import {
	isRecoverableBrowserError,
	MAX_RENDERED_DOM_NODES,
	readBoundedDocumentText,
	runPageOperationWithDeadline,
} from "./browserPage.js";

interface ConsentBypassResult {
	detected: boolean;
	bypassed: boolean;
}

const CONSENT_POLL_INTERVAL_MS = 100;
const MAX_CONSENT_CONTROLS = 500;
const MAX_CONSENT_CONTROL_TEXT_CHARS = 512;
const MAX_CONSENT_CONTROL_TEXT_NODES = 100;
const MAX_CONSENT_TEXT_CHARS = 256 * 1024;

async function readConsentBodyText(
	page: Page,
	signal: AbortSignal,
	visibleOnly: boolean,
): Promise<string> {
	while (true) {
		try {
			return await page.evaluate(readBoundedDocumentText, {
				maxChars: MAX_CONSENT_TEXT_CHARS,
				maxNodes: MAX_RENDERED_DOM_NODES,
				visibleOnly,
			});
		} catch (error) {
			if (!isRecoverableBrowserError(error)) throw error;
			await sleep(CONSENT_POLL_INTERVAL_MS, undefined, { signal });
		}
	}
}

export async function handleConsentModals(
	page: Page,
	url: string,
	logger: Logger,
	signal?: AbortSignal,
): Promise<ConsentBypassResult> {
	const EVAL_TIMEOUT_MS = DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.CONSENT_EVAL;
	const CLEAR_TIMEOUT_MS = DYNAMIC_RENDERER_CONSTANTS.TIMEOUTS.CONSENT_CLEAR;

	try {
		const bodyText = await runPageOperationWithDeadline({
			page,
			timeoutMs: EVAL_TIMEOUT_MS,
			operationName: "Consent body text extraction",
			...(signal ? { signal } : {}),
			run: (operationSignal) => readConsentBodyText(page, operationSignal, false),
		});

		if (!isConsentWallText(bodyText)) {
			return { detected: false, bypassed: false };
		}

		logger.info(`Consent wall detected on ${url}. Attempting to bypass...`);

		let clicked = false;
		const actionDeadline = Date.now() + EVAL_TIMEOUT_MS;
		while (!clicked && Date.now() < actionDeadline) {
			for (const frame of page.frames()) {
				try {
					clicked = await runPageOperationWithDeadline({
						page,
						timeoutMs: Math.max(1, actionDeadline - Date.now()),
						operationName: "Consent button evaluation",
						...(signal ? { signal } : {}),
						run: () =>
							frame.evaluate(
								({
									selectors,
									actionMarkers,
									negativeActionMarkers,
									maxControls,
									maxControlTextChars,
									maxControlTextNodes,
									maxNodes,
								}: {
									selectors: string[];
									actionMarkers: string[];
									negativeActionMarkers: string[];
									maxControls: number;
									maxControlTextChars: number;
									maxControlTextNodes: number;
									maxNodes: number;
								}) => {
									const interactiveSelector =
										"button, input[type='submit'], a[role='button'], [role='button']";

									function collectInteractiveElements(root: ParentNode): HTMLElement[] {
										const elements: HTMLElement[] = [];
										const roots: ParentNode[] = [root];
										let visitedNodes = 0;
										while (roots.length > 0) {
											const currentRoot = roots.pop();
											if (!currentRoot) break;
											const walker = document.createTreeWalker(
												currentRoot,
												NodeFilter.SHOW_ELEMENT,
											);
											while (walker.nextNode()) {
												visitedNodes += 1;
												if (visitedNodes > maxNodes) return elements;
												const node = walker.currentNode;
												if (!(node instanceof HTMLElement)) continue;
												if (node.matches(interactiveSelector)) {
													elements.push(node);
													if (elements.length >= maxControls) return elements;
												}
												if (node.shadowRoot) roots.push(node.shadowRoot);
											}
										}

										return elements;
									}

									function readControlText(control: HTMLElement): string {
										const walker = document.createTreeWalker(control, NodeFilter.SHOW_ALL);
										let text = "";
										let visitedNodes = 0;
										while (walker.nextNode()) {
											visitedNodes += 1;
											if (
												visitedNodes > maxControlTextNodes ||
												text.length >= maxControlTextChars
											) {
												break;
											}
											const node = walker.currentNode;
											if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue) continue;
											if (text.length > 0) text += " ";
											text += node.nodeValue.slice(0, maxControlTextChars - text.length);
										}
										return text;
									}

									function isVisible(element: HTMLElement): boolean {
										if (element.hidden) return false;
										if ("disabled" in element && element.disabled) return false;
										const style = window.getComputedStyle(element);
										return (
											style.display !== "none" &&
											style.visibility !== "hidden" &&
											style.pointerEvents !== "none"
										);
									}

									const buttons = collectInteractiveElements(document);
									const exactMatch = buttons.find(
										(button) =>
											isVisible(button) &&
											selectors.some((selector: string) => button.matches(selector)),
									);
									if (exactMatch) {
										exactMatch.click();
										return true;
									}

									const normalize = (value: string | null | undefined) =>
										(value ?? "")
											.slice(0, maxControlTextChars)
											.trim()
											.toLowerCase()
											.replace(/\s+/g, " ");
									const matchesAction = (...values: Array<string | null | undefined>) =>
										values.some((value) => {
											const normalized = normalize(value);
											if (
												negativeActionMarkers.some((marker: string) => normalized.includes(marker))
											) {
												return false;
											}
											return actionMarkers.some(
												(marker: string) =>
													normalized === marker || normalized.startsWith(`${marker} `),
											);
										});

									const textMatch = buttons.find((button) => {
										if (!isVisible(button)) return false;
										return matchesAction(
											readControlText(button),
											button.getAttribute("aria-label"),
											button.getAttribute("title"),
											button.getAttribute("value"),
										);
									});
									if (textMatch) {
										textMatch.click();
										return true;
									}

									return false;
								},
								{
									selectors: [...CONSENT_BUTTON_SELECTORS],
									actionMarkers: [...CONSENT_ACTION_MARKERS],
									negativeActionMarkers: [...CONSENT_NEGATIVE_ACTION_MARKERS],
									maxControls: MAX_CONSENT_CONTROLS,
									maxControlTextChars: MAX_CONSENT_CONTROL_TEXT_CHARS,
									maxControlTextNodes: MAX_CONSENT_CONTROL_TEXT_NODES,
									maxNodes: MAX_RENDERED_DOM_NODES,
								},
							),
					});
				} catch (error) {
					if (!isRecoverableBrowserError(error)) throw error;
					continue;
				}

				if (clicked) break;
			}
			if (!clicked && Date.now() < actionDeadline) {
				await sleep(CONSENT_POLL_INTERVAL_MS, undefined, signal ? { signal } : undefined);
			}
		}

		if (!clicked) {
			const visibleBodyText = await runPageOperationWithDeadline({
				page,
				timeoutMs: EVAL_TIMEOUT_MS,
				operationName: "Visible consent wall verification",
				...(signal ? { signal } : {}),
				run: (operationSignal) => readConsentBodyText(page, operationSignal, true),
			});
			if (!isConsentWallText(visibleBodyText)) {
				logger.debug(`Consent template found without a visible wall on ${url}`);
				return { detected: false, bypassed: false };
			}
			logger.info(`Consent wall did not become actionable on ${url}`);
			return { detected: true, bypassed: false };
		}

		logger.info(`Consent action clicked on ${url}, verifying dismissal...`);
		const cleared = await runPageOperationWithDeadline({
			page,
			timeoutMs: CLEAR_TIMEOUT_MS,
			operationName: "Consent wall dismissal",
			...(signal ? { signal } : {}),
			run: async (operationSignal) => {
				while (true) {
					const visibleBodyText = await readConsentBodyText(page, operationSignal, true);
					if (!isConsentWallText(visibleBodyText)) return true;
					await sleep(CONSENT_POLL_INTERVAL_MS, undefined, {
						signal: operationSignal,
					});
				}
			},
		});
		if (!cleared) {
			logger.info(`Consent wall remained visible after interaction on ${url}`);
		}
		return { detected: true, bypassed: cleared };
	} catch (error) {
		signal?.throwIfAborted();
		logger.info(`Consent bypass attempt failed: ${getErrorMessage(error)}`);
		return { detected: true, bypassed: false };
	}
}

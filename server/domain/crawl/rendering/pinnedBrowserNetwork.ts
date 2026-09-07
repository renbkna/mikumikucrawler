import { setTimeout as sleep } from "node:timers/promises";
import type {
	BrowserContext,
	BrowserContextOptions,
	Frame,
	Route,
	WebSocketRoute,
} from "playwright";
import { DYNAMIC_RENDERER_CONSTANTS } from "../../../constants.js";
import { type HttpClient, isOutboundPolicyError } from "../../../outbound/HttpClient.js";
import {
	isJsonContentType,
	isPdfContentType,
	isSupportedDocumentContentType,
	maxProcessableDocumentBytes,
} from "../../../processors/contentTypes.js";
import { getErrorMessage } from "../../../utils/helpers.js";
import { disposeResponseBody, readLimitedResponseBody } from "../../../utils/responseBody.js";
import { type WorkLease, WorkPermitPool } from "../../../utils/WorkPermitPool.js";
import type { DestinationAuthorizer } from "./contracts.js";

const BROWSER_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type BudgetedBody =
	| { type: "body"; bytes: Uint8Array }
	| { type: "rejected"; reason: "response-budget" | "response-too-large" };

class DynamicRouteBudgetError extends Error {}

/** One page owns this budget. Callers cannot replenish it or bypass serialized byte accounting. */
export function createDynamicRouteBudget(
	maxRequests: number = DYNAMIC_RENDERER_CONSTANTS.NETWORK_BUDGET.MAX_REQUESTS_PER_PAGE,
	maxBytes: number = DYNAMIC_RENDERER_CONSTANTS.NETWORK_BUDGET.MAX_RESPONSE_BYTES_PER_PAGE,
) {
	if (
		!Number.isSafeInteger(maxRequests) ||
		maxRequests < 0 ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 0
	) {
		throw new RangeError("Dynamic route budgets must be non-negative safe integers");
	}
	let remainingRequests = maxRequests;
	let remainingBytes = maxBytes;
	const acquireBodyRead = new WorkPermitPool(1).acquire;
	return {
		chargeRequest(): boolean {
			if (remainingRequests === 0) return false;
			remainingRequests -= 1;
			return true;
		},
		async readBody(
			response: Response,
			contentLimit: number,
			signal?: AbortSignal,
		): Promise<BudgetedBody> {
			let releaseBodyRead: WorkLease;
			try {
				releaseBodyRead = await acquireBodyRead(signal);
			} catch (error) {
				await disposeResponseBody(response);
				throw error;
			}
			try {
				const responseBudgetOwnsLimit = remainingBytes < contentLimit;
				const body = await readLimitedResponseBody(
					response,
					Math.min(contentLimit, remainingBytes),
					signal,
				);
				if (body.type === "tooLarge") {
					if (responseBudgetOwnsLimit) remainingBytes = 0;
					return {
						type: "rejected",
						reason: responseBudgetOwnsLimit ? "response-budget" : "response-too-large",
					};
				}
				remainingBytes -= body.bytes.byteLength;
				return body;
			} finally {
				releaseBodyRead();
			}
		},
	};
}

type DynamicRouteBudget = ReturnType<typeof createDynamicRouteBudget>;

type DynamicSubrequestAdmission = {
	acquire(url: string, signal?: AbortSignal): Promise<WorkLease>;
	waitForDispatch(url: string, signal?: AbortSignal): Promise<void>;
};

export function createDynamicSubrequestAdmission(
	maxConcurrent: number = DYNAMIC_RENDERER_CONSTANTS.NETWORK_BUDGET.MAX_CONCURRENT_SUBREQUESTS,
	minimumDelayMs: number = DYNAMIC_RENDERER_CONSTANTS.NETWORK_BUDGET.MIN_SUBREQUEST_DELAY_MS,
): DynamicSubrequestAdmission {
	const permits = new WorkPermitPool(maxConcurrent);
	const nextAllowedAt = new Map<string, number>();
	const waitForDispatch = async (url: string, signal?: AbortSignal) => {
		const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
		const now = Date.now();
		const dispatchAt = Math.max(now, nextAllowedAt.get(hostname) ?? 0);
		nextAllowedAt.set(hostname, dispatchAt + minimumDelayMs);
		if (dispatchAt > now) {
			await sleep(dispatchAt - now, undefined, signal ? { signal } : undefined);
		}
	};
	return {
		waitForDispatch,
		async acquire(url, signal) {
			const release = await permits.acquire(signal);
			try {
				await waitForDispatch(url, signal);
				return release;
			} catch (error) {
				release();
				throw error;
			}
		},
	};
}

export interface DynamicDocumentResponse {
	url: string;
	statusCode: number;
	contentType: string;
	xRobotsTag: string | null;
	retryAfter: string | null;
}

export type DynamicRouteResult =
	| { type: "fulfilled"; documentResponse?: DynamicDocumentResponse }
	| { type: "continued" }
	| { type: "aborted"; reason: "static-representation"; url: string }
	| {
			type: "aborted";
			reason: "unsupported-content";
			contentType: string;
			statusCode: number;
	  }
	| {
			type: "aborted";
			reason:
				| "policy"
				| "unsupported-method"
				| "request-budget"
				| "response-budget"
				| "response-too-large"
				| "transport-failure";
			message?: string;
	  };

interface DynamicRouteRequestOptions {
	signal?: AbortSignal;
	allowLocalhostOnInitialRequest?: boolean;
	budget?: DynamicRouteBudget;
	authorizeDocumentRequest?: DestinationAuthorizer;
	authorizeDocumentRedirect?: DestinationAuthorizer;
	admitSubrequest?: DynamicSubrequestAdmission;
	isMainDocument?: boolean;
}

export function requiresStaticRepresentationFetch(contentType: string): boolean {
	return isJsonContentType(contentType) || isPdfContentType(contentType);
}

function shouldSkipSecurityValidation(url: string): boolean {
	return url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:");
}

function createRouteFulfillHeaders(headers: Headers): Record<string, string> {
	const fulfilledHeaders = new Headers(headers);
	fulfilledHeaders.delete("content-encoding");
	fulfilledHeaders.delete("content-length");
	return Object.fromEntries(fulfilledHeaders);
}

export async function fulfillRouteWithPinnedHttpClient(
	route: Route,
	httpClient: HttpClient,
	options: DynamicRouteRequestOptions = {},
): Promise<DynamicRouteResult> {
	const request = route.request();
	const requestUrl = request.url();
	const isDocument = request.resourceType() === "document";
	const isMainDocument = isDocument && (options.isMainDocument ?? true);
	const budget = options.budget ?? createDynamicRouteBudget();
	if (shouldSkipSecurityValidation(requestUrl)) {
		await route.continue();
		return { type: "continued" };
	}

	const parsed = new URL(requestUrl);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		await route.abort();
		return { type: "aborted", reason: "policy" };
	}

	if (["image", "stylesheet", "font", "media"].includes(request.resourceType())) {
		await route.abort();
		return { type: "aborted", reason: "policy" };
	}

	const method = request.method().toUpperCase();
	if (method !== "GET" && method !== "HEAD") {
		await route.abort();
		return { type: "aborted", reason: "unsupported-method" };
	}

	if (!budget.chargeRequest()) {
		await route.abort();
		return { type: "aborted", reason: "request-budget" };
	}

	let releaseSubrequest: WorkLease | undefined;
	try {
		if (!isMainDocument && options.admitSubrequest) {
			releaseSubrequest = await options.admitSubrequest.acquire(requestUrl, options.signal);
		}
		await options.authorizeDocumentRequest?.(requestUrl, options.signal);
		const response = await httpClient.fetch({
			url: requestUrl,
			headers: request.headers(),
			method,
			signal: options.signal,
			...(isDocument ? { redirect: "manual" as const } : {}),
			...(options.allowLocalhostOnInitialRequest ? { allowLocalhostOnInitialRequest: true } : {}),
			authorizeRedirect: async (hop, redirectSignal) => {
				if (!isDocument) {
					if (!budget.chargeRequest()) {
						throw new DynamicRouteBudgetError("Dynamic redirect request budget exhausted");
					}
					await options.admitSubrequest?.waitForDispatch(hop.toUrl, redirectSignal);
				}
				await options.authorizeDocumentRedirect?.(hop.toUrl, redirectSignal);
			},
		});
		const contentType = response.headers.get("content-type") ?? "";
		const isBrowserRedirect =
			isDocument &&
			BROWSER_REDIRECT_STATUSES.has(response.status) &&
			response.headers.has("location");
		if (isDocument && !isBrowserRedirect) {
			if (requiresStaticRepresentationFetch(contentType)) {
				await disposeResponseBody(response);
				await route.abort();
				return { type: "aborted", reason: "static-representation", url: requestUrl };
			}
			if (response.ok && !isSupportedDocumentContentType(contentType)) {
				await disposeResponseBody(response);
				await route.abort();
				return {
					type: "aborted",
					reason: "unsupported-content",
					contentType,
					statusCode: response.status,
				};
			}
		}
		if (isBrowserRedirect) {
			await disposeResponseBody(response);
			await route.fulfill({
				status: response.status,
				headers: createRouteFulfillHeaders(response.headers),
			});
			return { type: "fulfilled" };
		}
		const body = await budget.readBody(
			response,
			isDocument ? maxProcessableDocumentBytes(contentType) : Number.POSITIVE_INFINITY,
			options.signal,
		);
		if (body.type === "rejected") {
			await route.abort();
			return { type: "aborted", reason: body.reason };
		}

		await route.fulfill({
			status: response.status,
			headers: createRouteFulfillHeaders(response.headers),
			body: Buffer.from(body.bytes),
		});
		return {
			type: "fulfilled",
			...(isMainDocument
				? {
						documentResponse: {
							url: requestUrl,
							statusCode: response.status,
							contentType,
							xRobotsTag: response.headers.get("x-robots-tag"),
							retryAfter: response.headers.get("retry-after"),
						},
					}
				: {}),
		};
	} catch (error) {
		await route.abort();
		if (error instanceof DynamicRouteBudgetError) {
			return { type: "aborted", reason: "request-budget", message: error.message };
		}
		if (isOutboundPolicyError(error)) {
			return { type: "aborted", reason: "policy", message: error.message };
		}
		return {
			type: "aborted",
			reason: "transport-failure",
			message: getErrorMessage(error),
		};
	} finally {
		releaseSubrequest?.();
	}
}

export function createDynamicBrowserContextOptions(): BrowserContextOptions {
	return { serviceWorkers: "block" };
}

export function createDynamicBrowserLaunchArgs(): string[] {
	return [
		"--disable-dev-shm-usage",
		"--disable-gpu",
		"--disable-blink-features=AutomationControlled",
		"--disable-extensions",
		"--disable-background-networking",
		"--disable-quic",
	];
}

async function abortWebSocketRoute(route: WebSocketRoute): Promise<void> {
	await route.close({
		code: 1008,
		reason: "WebSockets are not allowed during crawling",
	});
}

export async function configurePinnedBrowserContext(
	context: BrowserContext,
	httpClient: HttpClient,
	signal?: AbortSignal,
	seedUrl?: string,
	onDocumentResult?: (result: DynamicRouteResult, url: string) => void,
	authorizeDocumentDestination?: DestinationAuthorizer,
	mainFrame?: Frame,
): Promise<void> {
	await context.addInitScript(() => {
		Object.defineProperties(globalThis, {
			RTCPeerConnection: { value: undefined, writable: false, configurable: false },
			webkitRTCPeerConnection: { value: undefined, writable: false, configurable: false },
			WebTransport: { value: undefined, writable: false, configurable: false },
		});
	});
	let seedCapabilityAvailable = seedUrl !== undefined;
	let initialMainDocumentAvailable = true;
	let preauthorizedDocumentUrl: string | undefined;
	const budget = createDynamicRouteBudget();
	const admitSubrequest = createDynamicSubrequestAdmission();
	await context.route("**/*", async (route) => {
		const request = route.request();
		let isMainDocument = request.resourceType() === "document";
		if (isMainDocument && mainFrame) {
			try {
				isMainDocument = request.frame() === mainFrame;
			} catch {
				isMainDocument = false;
			}
		}
		const isInitialMainDocument = isMainDocument && initialMainDocumentAvailable;
		if (isInitialMainDocument) {
			initialMainDocumentAvailable = false;
		}
		const isPreauthorizedDocument = isMainDocument && preauthorizedDocumentUrl === request.url();
		if (isMainDocument) {
			preauthorizedDocumentUrl = undefined;
		}
		const useSeedCapability =
			seedCapabilityAvailable && isMainDocument && request.url() === seedUrl;
		if (useSeedCapability) {
			seedCapabilityAvailable = false;
		}
		const result = await fulfillRouteWithPinnedHttpClient(route, httpClient, {
			signal,
			allowLocalhostOnInitialRequest: useSeedCapability,
			budget,
			authorizeDocumentRequest:
				isMainDocument && !isInitialMainDocument && !isPreauthorizedDocument
					? authorizeDocumentDestination
					: undefined,
			authorizeDocumentRedirect:
				isMainDocument && authorizeDocumentDestination
					? async (url, redirectSignal) => {
							await authorizeDocumentDestination(url, redirectSignal);
							preauthorizedDocumentUrl = url;
						}
					: undefined,
			admitSubrequest,
			isMainDocument,
		});
		if (isMainDocument) {
			onDocumentResult?.(result, request.url());
		}
	});
	await context.routeWebSocket("**/*", abortWebSocketRoute);
}

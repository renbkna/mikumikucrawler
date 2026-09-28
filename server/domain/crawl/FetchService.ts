import type { Logger } from "../../config/logging.js";
import {
	DYNAMIC_RENDER_TIMEOUT_MS,
	FETCH_HEADERS,
	RETRY_CONSTANTS,
	TIMEOUT_CONSTANTS,
} from "../../constants.js";
import { type HttpClient, isOutboundPolicyError } from "../../outbound/HttpClient.js";
import {
	isPdfContentType,
	isSupportedDocumentContentType,
	maxProcessableDocumentBytes,
} from "../../processors/contentTypes.js";
import { getErrorMessage } from "../../utils/helpers.js";
import { disposeResponseBody, readLimitedResponseBody } from "../../utils/responseBody.js";
import type { AcquireWork, WorkLease } from "../../utils/WorkPermitPool.js";
import type { QueueItem } from "./CrawlQueue.js";
import {
	isAccessBlockedStatus,
	isPermanentFetchFailureStatus,
	isRateLimitedStatus,
	isTransientFetchFailureStatus,
} from "./httpStatusPolicy.js";
import type {
	DestinationAuthorizer,
	DocumentRenderer,
	DynamicRenderAttempt,
} from "./rendering/contracts.js";

export type FetchResult =
	| {
			type: "success";
			content: string | Buffer;
			effectiveUrl: string;
			statusCode: number;
			contentType: string;
			contentLength: number;
			title: string;
			description: string;
			xRobotsTag: string | null;
			releasePdfWork?: WorkLease;
	  }
	| {
			type: "rateLimited";
			statusCode: number;
			retryAfterMs?: number;
	  }
	| {
			type: "transientFailure";
			statusCode: number;
			retryAfterMs?: number;
	  }
	| {
			type: "permanentFailure";
			statusCode: number;
	  }
	| {
			type: "unsupported";
			statusCode: number;
			contentType: string;
	  }
	| {
			type: "blocked";
			statusCode: number;
			reason?: string;
	  };

function parseRetryAfter(value: string | null): number | undefined {
	if (!value) return undefined;
	if (/^\d+$/.test(value.trim())) {
		return Math.min(Number.parseInt(value, 10) * 1000, RETRY_CONSTANTS.MAX_DELAY);
	}

	const parsedDate = Date.parse(value);
	if (!Number.isNaN(parsedDate)) {
		return Math.min(Math.max(parsedDate - Date.now(), 0), RETRY_CONSTANTS.MAX_DELAY);
	}

	return undefined;
}

async function readResponseContent(
	response: Response,
	contentType: string,
	signal?: AbortSignal,
): Promise<
	{ type: "content"; content: string | Buffer; contentLength: number } | { type: "tooLarge" }
> {
	const body = await readLimitedResponseBody(
		response,
		maxProcessableDocumentBytes(contentType),
		signal,
	);
	if (body.type === "tooLarge") {
		return { type: "tooLarge" };
	}

	return isPdfContentType(contentType)
		? {
				type: "content",
				content: Buffer.from(body.bytes.buffer, body.bytes.byteOffset, body.bytes.byteLength),
				contentLength: body.bytes.byteLength,
			}
		: {
				type: "content",
				content: decodeDocumentBytes(body.bytes, contentType),
				contentLength: body.bytes.byteLength,
			};
}

function decodeDocumentBytes(bytes: Uint8Array, contentType: string): string {
	const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/i.exec(contentType);
	const declared = match?.[1] ?? match?.[2] ?? match?.[3];
	if (declared) {
		try {
			return new TextDecoder(declared).decode(bytes);
		} catch {
			// Unsupported labels fall back to the platform's replacement-mode UTF-8 decoder.
		}
	}
	return new TextDecoder("utf-8").decode(bytes);
}

/** Facts about a final document response, whichever transport produced it. */
interface DocumentResponseFacts {
	requestUrl: string;
	statusCode: number;
	contentType: string;
	retryAfter: string | null;
}

type FetchFailure = Exclude<FetchResult, { type: "success" }>;

const TRANSPORT_FAILURE: FetchFailure = { type: "transientFailure", statusCode: 0 };

function responseTooLarge(requestUrl: string): FetchFailure {
	return { type: "blocked", statusCode: 413, reason: `Response too large for ${requestUrl}` };
}

/** The single policy that decides whether a final document response is crawlable content. */
function classifyDocumentResponse(facts: DocumentResponseFacts): FetchFailure | null {
	const { requestUrl, statusCode, contentType } = facts;
	if (isRateLimitedStatus(statusCode)) {
		return { type: "rateLimited", statusCode, retryAfterMs: parseRetryAfter(facts.retryAfter) };
	}
	if (isPermanentFetchFailureStatus(statusCode)) {
		return { type: "permanentFailure", statusCode };
	}
	if (isTransientFetchFailureStatus(statusCode)) {
		return {
			type: "transientFailure",
			statusCode,
			retryAfterMs: parseRetryAfter(facts.retryAfter),
		};
	}
	if (isAccessBlockedStatus(statusCode)) {
		return { type: "blocked", statusCode, reason: `Access blocked for ${requestUrl}` };
	}
	if (statusCode === 304) {
		return {
			type: "blocked",
			statusCode,
			reason: `Received unexpected 304 for unconditional request to ${requestUrl}`,
		};
	}
	if (statusCode < 200 || statusCode >= 300) {
		return { type: "permanentFailure", statusCode };
	}
	if (!isSupportedDocumentContentType(contentType)) {
		return { type: "unsupported", statusCode, contentType };
	}
	return null;
}

export interface FetchServiceDependencies {
	httpClient: HttpClient;
	dynamicRenderer: DocumentRenderer;
	logger: Logger;
	/** The seed URL granted the localhost capability on its first request, if any. */
	localSeedUrl?: string;
	acquirePdfWork?: AcquireWork;
	/** Per-acquisition deadlines; default to the crawler's render and document timeouts. */
	deadlines?: { renderMs: number; documentMs: number };
}

export class FetchService {
	private readonly deadlines: { renderMs: number; documentMs: number };

	constructor(private readonly deps: FetchServiceDependencies) {
		this.deadlines = deps.deadlines ?? {
			renderMs: DYNAMIC_RENDER_TIMEOUT_MS,
			documentMs: TIMEOUT_CONSTANTS.DOCUMENT_FETCH,
		};
	}

	async fetch(
		item: QueueItem,
		signal?: AbortSignal,
		authorizeDestination?: DestinationAuthorizer,
	): Promise<FetchResult> {
		// Each acquisition owns its deadline, so a slow render cannot spend the static fallback's.
		const deadline = (timeoutMs: number) =>
			signal
				? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
				: AbortSignal.timeout(timeoutMs);
		let staticUrl = item.url;
		if (this.deps.dynamicRenderer.isEnabled()) {
			const renderSignal = deadline(this.deadlines.renderMs);
			let dynamicResult: DynamicRenderAttempt | undefined;
			try {
				dynamicResult = await this.deps.dynamicRenderer.render(
					item.url,
					renderSignal,
					authorizeDestination,
				);
			} catch (error) {
				signal?.throwIfAborted();
				if (renderSignal.aborted) return TRANSPORT_FAILURE;
				this.deps.logger.warn(
					`[Fetch] Dynamic render failed for ${item.url}; falling back to static crawl: ${getErrorMessage(error)}`,
				);
			}
			if (renderSignal.aborted) {
				signal?.throwIfAborted();
				return TRANSPORT_FAILURE;
			}
			if (dynamicResult?.type === "staticFallback") {
				staticUrl = dynamicResult.targetUrl ?? item.url;
			} else if (dynamicResult) {
				return this.dynamicFetchResult(item, dynamicResult);
			}
		}

		// Consent-sensitive domains should not silently degrade to static junk when
		// the dynamic path already proved access is blocked by an interstitial wall.
		this.deps.logger.info(`[Fetch] Static crawl for ${staticUrl}`);
		const documentSignal = deadline(this.deadlines.documentMs);
		const documentTimedOut = () => documentSignal.aborted && signal?.aborted !== true;
		let response: Response;
		try {
			response = await this.deps.httpClient.fetch({
				url: staticUrl,
				headers: FETCH_HEADERS,
				signal: documentSignal,
				allowLocalhostOnInitialRequest: staticUrl === this.deps.localSeedUrl,
				...(authorizeDestination
					? {
							authorizeRedirect: (hop, redirectSignal) =>
								authorizeDestination(hop.toUrl, redirectSignal),
						}
					: {}),
			});
		} catch (error) {
			signal?.throwIfAborted();
			if (isOutboundPolicyError(error)) {
				return { type: "blocked", statusCode: 0, reason: error.message };
			}
			this.deps.logger.warn(
				`[Fetch] Transient fetch failure for ${item.url}: ${getErrorMessage(error)}`,
			);
			return TRANSPORT_FAILURE;
		}
		if (documentSignal.aborted) {
			await disposeResponseBody(response);
			signal?.throwIfAborted();
			return TRANSPORT_FAILURE;
		}

		const contentType = response.headers.get("content-type") ?? "";
		const failure = classifyDocumentResponse({
			requestUrl: item.url,
			statusCode: response.status,
			contentType,
			retryAfter: response.headers.get("retry-after"),
		});
		if (failure) {
			await disposeResponseBody(response);
			return failure;
		}

		let releasePdfWork: WorkLease | undefined;
		try {
			if (isPdfContentType(contentType) && this.deps.acquirePdfWork) {
				releasePdfWork = await this.deps.acquirePdfWork(documentSignal);
			}
		} catch (error) {
			await disposeResponseBody(response);
			signal?.throwIfAborted();
			if (documentTimedOut()) return TRANSPORT_FAILURE;
			throw error;
		}
		let readContent: Awaited<ReturnType<typeof readResponseContent>>;
		try {
			readContent = await readResponseContent(response, contentType, documentSignal);
		} catch (error) {
			releasePdfWork?.();
			signal?.throwIfAborted();
			if (documentTimedOut()) return TRANSPORT_FAILURE;
			throw error;
		}
		if (readContent.type === "tooLarge") {
			releasePdfWork?.();
			return responseTooLarge(item.url);
		}
		return {
			type: "success",
			content: readContent.content,
			effectiveUrl: response.url || staticUrl,
			statusCode: response.status,
			contentType,
			contentLength: readContent.contentLength,
			title: "",
			description: "",
			xRobotsTag: response.headers.get("x-robots-tag"),
			...(releasePdfWork ? { releasePdfWork } : {}),
		};
	}

	private dynamicFetchResult(
		item: QueueItem,
		attempt: Exclude<DynamicRenderAttempt, { type: "staticFallback" }>,
	): FetchResult {
		switch (attempt.type) {
			case "consentBlocked":
				this.deps.logger.warn(attempt.message);
				return { type: "blocked", statusCode: attempt.statusCode, reason: attempt.message };
			case "policyBlocked":
				return { type: "blocked", statusCode: 0, reason: attempt.message };
			case "transportFailure":
				this.deps.logger.warn(
					`[Fetch] Dynamic document transport failed for ${item.url}: ${attempt.message}`,
				);
				return TRANSPORT_FAILURE;
			case "tooLarge":
				return responseTooLarge(item.url);
			case "unsupported":
				return {
					type: "unsupported",
					statusCode: attempt.statusCode,
					contentType: attempt.contentType,
				};
			case "success": {
				const page = attempt.result;
				const failure = classifyDocumentResponse({
					requestUrl: item.url,
					statusCode: page.statusCode,
					contentType: page.contentType,
					retryAfter: page.retryAfter ?? null,
				});
				if (failure) return failure;
				return {
					type: "success",
					content: page.content,
					effectiveUrl: page.effectiveUrl,
					statusCode: page.statusCode,
					contentType: page.contentType,
					contentLength: Buffer.byteLength(page.content, "utf8"),
					title: page.title,
					description: page.description,
					xRobotsTag: page.xRobotsTag ?? null,
				};
			}
		}
	}
}

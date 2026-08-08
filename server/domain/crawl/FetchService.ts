import type { Logger } from "../../config/logging.js";
import { FETCH_HEADERS, RETRY_CONSTANTS, TIMEOUT_CONSTANTS } from "../../constants.js";
import { type HttpClient, isOutboundPolicyError } from "../../outbound/HttpClient.js";
import {
	isPdfContentType,
	isSupportedDocumentContentType,
	maxProcessableDocumentBytes,
} from "../../processors/contentTypes.js";
import { disposeResponseBody, readLimitedResponseBody } from "../../utils/responseBody.js";
import type { AcquireWork, WorkLease } from "../../utils/WorkPermitPool.js";
import type { QueueItem } from "./CrawlQueue.js";
import type { DynamicRenderer } from "./DynamicRenderer.js";
import {
	isAccessBlockedStatus,
	isPermanentFetchFailureStatus,
	isRateLimitedStatus,
	isTransientFetchFailureStatus,
} from "./httpStatusPolicy.js";

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

export type DestinationAuthorizer = (url: string, signal?: AbortSignal) => Promise<void> | void;
type DocumentRenderer = Pick<DynamicRenderer, "isEnabled" | "render">;

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
				contentLength: body.contentLength,
			}
		: {
				type: "content",
				content: decodeDocumentBytes(body.bytes, contentType),
				contentLength: body.contentLength,
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

function classifyFetchStatus(
	statusCode: number,
	retryAfterMs?: number,
): Exclude<FetchResult, { type: "success" }> | null {
	if (isRateLimitedStatus(statusCode)) {
		return {
			type: "rateLimited",
			statusCode,
			retryAfterMs,
		};
	}

	if (isPermanentFetchFailureStatus(statusCode)) {
		return {
			type: "permanentFailure",
			statusCode,
		};
	}

	if (isTransientFetchFailureStatus(statusCode)) {
		return {
			type: "transientFailure",
			statusCode,
			retryAfterMs,
		};
	}

	return null;
}

export class FetchService {
	constructor(
		private readonly httpClient: HttpClient,
		private readonly dynamicRenderer: DocumentRenderer,
		private readonly logger: Logger,
		private readonly localSeedUrl?: string,
		private readonly acquirePdfWork?: AcquireWork,
	) {}

	async fetch(
		item: QueueItem,
		signal?: AbortSignal,
		authorizeDestination?: DestinationAuthorizer,
	): Promise<FetchResult> {
		const documentSignal = signal
			? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_CONSTANTS.DOCUMENT_FETCH)])
			: AbortSignal.timeout(TIMEOUT_CONSTANTS.DOCUMENT_FETCH);
		const documentTimedOut = () => documentSignal.aborted && signal?.aborted !== true;
		let staticUrl = item.url;
		let dynamicResult: Awaited<ReturnType<DynamicRenderer["render"]>> | undefined;
		if (this.dynamicRenderer.isEnabled()) {
			try {
				dynamicResult = await this.dynamicRenderer.render(
					item,
					documentSignal,
					authorizeDestination,
				);
			} catch (error) {
				signal?.throwIfAborted();
				if (documentTimedOut()) {
					return { type: "transientFailure", statusCode: 0 };
				}
				this.logger.warn(
					`[Fetch] Dynamic render failed for ${item.url}; falling back to static crawl: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		if (documentSignal.aborted) {
			signal?.throwIfAborted();
			return { type: "transientFailure", statusCode: 0 };
		}

		if (dynamicResult) {
			if (dynamicResult.type === "consentBlocked") {
				this.logger.warn(dynamicResult.message);
				return {
					type: "blocked",
					statusCode: dynamicResult.statusCode,
					reason: dynamicResult.message,
				};
			}
			if (dynamicResult.type === "policyBlocked") {
				return { type: "blocked", statusCode: 0, reason: dynamicResult.message };
			}
			if (dynamicResult.type === "transportFailure") {
				this.logger.warn(
					`[Fetch] Dynamic document transport failed for ${item.url}: ${dynamicResult.message}`,
				);
				return {
					type: "transientFailure",
					statusCode: 0,
				};
			}
			if (dynamicResult.type === "tooLarge") {
				return {
					type: "blocked",
					statusCode: 413,
					reason: `Response too large for ${item.url}`,
				};
			}
			if (dynamicResult.type === "unsupported") {
				return {
					type: "unsupported",
					statusCode: dynamicResult.statusCode,
					contentType: dynamicResult.contentType,
				};
			}
			if (dynamicResult.type === "staticFallback") {
				staticUrl = dynamicResult.targetUrl ?? item.url;
				dynamicResult = undefined;
			} else {
				const renderedPage = dynamicResult.result;
				const classifiedDynamicStatus = classifyFetchStatus(
					renderedPage.statusCode,
					parseRetryAfter(renderedPage.retryAfter ?? null),
				);
				if (classifiedDynamicStatus) {
					return classifiedDynamicStatus;
				}

				if (isAccessBlockedStatus(renderedPage.statusCode)) {
					return {
						type: "blocked",
						statusCode: renderedPage.statusCode,
						reason: `Access blocked for ${item.url}`,
					};
				}

				if (renderedPage.statusCode === 304) {
					return {
						type: "blocked",
						statusCode: 304,
						reason: `Received unexpected 304 for unconditional request to ${item.url}`,
					};
				}

				if (renderedPage.statusCode < 200 || renderedPage.statusCode >= 300) {
					return {
						type: "permanentFailure",
						statusCode: renderedPage.statusCode,
					};
				}

				if (!isSupportedDocumentContentType(renderedPage.contentType)) {
					return {
						type: "unsupported",
						statusCode: renderedPage.statusCode,
						contentType: renderedPage.contentType,
					};
				}

				const contentLength = Buffer.byteLength(renderedPage.content, "utf8");

				return {
					type: "success",
					content: renderedPage.content,
					effectiveUrl: renderedPage.effectiveUrl,
					statusCode: renderedPage.statusCode,
					contentType: renderedPage.contentType,
					contentLength,
					title: renderedPage.title,
					description: renderedPage.description,
					xRobotsTag: renderedPage.xRobotsTag ?? null,
				};
			}
		}

		// Consent-sensitive domains should not silently degrade to static junk when
		// the dynamic path already proved access is blocked by an interstitial wall.
		this.logger.info(`[Fetch] Static crawl for ${staticUrl}`);
		let response: Response;
		try {
			response = await this.httpClient.fetch({
				url: staticUrl,
				headers: FETCH_HEADERS,
				signal: documentSignal,
				allowLocalhostOnInitialRequest:
					this.localSeedUrl !== undefined && staticUrl === this.localSeedUrl,
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
				return {
					type: "blocked",
					statusCode: 0,
					reason: error.message,
				};
			}
			this.logger.warn(
				`[Fetch] Transient fetch failure for ${item.url}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return {
				type: "transientFailure",
				statusCode: 0,
			};
		}
		if (documentSignal.aborted) {
			await disposeResponseBody(response);
			signal?.throwIfAborted();
			return { type: "transientFailure", statusCode: 0 };
		}

		if (response.status === 304) {
			await disposeResponseBody(response);
			return {
				type: "blocked",
				statusCode: 304,
				reason: `Received unexpected 304 for unconditional request to ${item.url}`,
			};
		}
		const effectiveUrl = response.url || staticUrl;

		const classifiedStaticStatus = classifyFetchStatus(
			response.status,
			parseRetryAfter(response.headers.get("retry-after")),
		);
		if (classifiedStaticStatus) {
			await disposeResponseBody(response);
			return classifiedStaticStatus;
		}

		if (isAccessBlockedStatus(response.status)) {
			await disposeResponseBody(response);
			return {
				type: "blocked",
				statusCode: response.status,
				reason: `Access blocked for ${item.url}`,
			};
		}

		if (!response.ok) {
			await disposeResponseBody(response);
			return {
				type: "permanentFailure",
				statusCode: response.status,
			};
		}

		const contentType = response.headers.get("content-type") ?? "";
		if (!isSupportedDocumentContentType(contentType)) {
			await disposeResponseBody(response);
			return {
				type: "unsupported",
				statusCode: response.status,
				contentType,
			};
		}
		let releasePdfWork: WorkLease | undefined;
		try {
			if (isPdfContentType(contentType) && this.acquirePdfWork) {
				releasePdfWork = await this.acquirePdfWork(documentSignal);
			}
		} catch (error) {
			await disposeResponseBody(response);
			signal?.throwIfAborted();
			if (documentTimedOut()) {
				return { type: "transientFailure", statusCode: 0 };
			}
			throw error;
		}
		let readContent: Awaited<ReturnType<typeof readResponseContent>>;
		try {
			readContent = await readResponseContent(response, contentType, documentSignal);
		} catch (error) {
			releasePdfWork?.();
			signal?.throwIfAborted();
			if (documentTimedOut()) {
				return { type: "transientFailure", statusCode: 0 };
			}
			throw error;
		}
		if (readContent.type === "tooLarge") {
			releasePdfWork?.();
			return {
				type: "blocked",
				statusCode: 413,
				reason: `Response too large for ${item.url}`,
			};
		}
		return {
			type: "success",
			content: readContent.content,
			effectiveUrl,
			statusCode: response.status,
			contentType,
			contentLength: readContent.contentLength,
			title: "",
			description: "",
			xRobotsTag: response.headers.get("x-robots-tag"),
			...(releasePdfWork ? { releasePdfWork } : {}),
		};
	}
}

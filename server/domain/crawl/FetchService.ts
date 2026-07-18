import type { Logger } from "../../config/logging.js";
import { FETCH_HEADERS, RETRY_CONSTANTS, TIMEOUT_CONSTANTS } from "../../constants.js";
import type { HttpClient } from "../../plugins/security.js";
import {
	isPdfContentType,
	isSupportedDocumentContentType,
	maxProcessableDocumentBytes,
} from "../../processors/contentTypes.js";
import { disposeResponseBody, readLimitedResponseBody } from "../../utils/responseBody.js";
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
			lastModified: string | null;
			etag: string | null;
			xRobotsTag: string | null;
			isDynamic: boolean;
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
): Promise<
	{ type: "content"; content: string | Buffer; contentLength: number } | { type: "tooLarge" }
> {
	const body = await readLimitedResponseBody(response, maxProcessableDocumentBytes(contentType));
	if (body.type === "tooLarge") {
		return { type: "tooLarge" };
	}

	return isPdfContentType(contentType)
		? {
				type: "content",
				content: Buffer.from(body.bytes),
				contentLength: body.contentLength,
			}
		: {
				type: "content",
				content: new TextDecoder().decode(body.bytes),
				contentLength: body.contentLength,
			};
}

function classifyFetchStatus(
	statusCode: number,
	options: {
		retryAfterMs?: number;
		blockedStatuses: readonly number[];
		blockedReason?: string;
	},
): Exclude<FetchResult, { type: "success" }> | null {
	if (isRateLimitedStatus(statusCode)) {
		return {
			type: "rateLimited",
			statusCode,
			retryAfterMs: options.retryAfterMs,
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
			retryAfterMs: options.retryAfterMs,
		};
	}

	if (options.blockedStatuses.includes(statusCode)) {
		return {
			type: "blocked",
			statusCode,
			reason: options.blockedReason,
		};
	}

	return null;
}

export class FetchService {
	constructor(
		private readonly httpClient: HttpClient,
		private readonly dynamicRenderer: DynamicRenderer,
		private readonly logger: Logger,
		private readonly localSeedUrl?: string,
	) {}

	async fetch(item: QueueItem, signal?: AbortSignal): Promise<FetchResult> {
		let dynamicResult: Awaited<ReturnType<DynamicRenderer["render"]>> | undefined;
		if (this.dynamicRenderer.isEnabled()) {
			try {
				dynamicResult = await this.dynamicRenderer.render(item, signal);
			} catch (error) {
				if (signal?.aborted) {
					throw signal.reason instanceof Error ? signal.reason : new Error("Fetch aborted");
				}
				this.logger.warn(
					`[Fetch] Dynamic render failed for ${item.url}; falling back to static crawl: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("Fetch aborted");
		}

		if (dynamicResult) {
			if (signal?.aborted) {
				throw signal.reason instanceof Error ? signal.reason : new Error("Fetch aborted");
			}
			if (dynamicResult.type === "consentBlocked") {
				this.logger.warn(dynamicResult.message);
				return {
					type: "blocked",
					statusCode: dynamicResult.statusCode,
					reason: dynamicResult.message,
				};
			}
			if (dynamicResult.type === "transportFailure") {
				this.logger.warn(
					`[Fetch] Dynamic document transport failed for ${item.url}: ${dynamicResult.message}`,
				);
				return {
					type: "transientFailure",
					statusCode: 0,
					retryAfterMs: RETRY_CONSTANTS.BASE_DELAY,
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
				dynamicResult = undefined;
			} else {
				const renderedPage = dynamicResult.result;
				const classifiedDynamicStatus = classifyFetchStatus(renderedPage.statusCode, {
					retryAfterMs: parseRetryAfter(renderedPage.retryAfter ?? null),
					blockedStatuses: [],
					blockedReason: `Access blocked for ${item.url}`,
				});
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

				if (renderedPage.statusCode >= 400) {
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
					lastModified: renderedPage.lastModified ?? null,
					etag: renderedPage.etag ?? null,
					xRobotsTag: renderedPage.xRobotsTag ?? null,
					isDynamic: true,
				};
			}
		}

		// Consent-sensitive domains should not silently degrade to static junk when
		// the dynamic path already proved access is blocked by an interstitial wall.
		this.logger.info(`[Fetch] Static crawl for ${item.url}`);
		let response: Response;
		try {
			response = await this.httpClient.fetch({
				url: item.url,
				headers: FETCH_HEADERS,
				signal:
					signal && "any" in AbortSignal
						? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_CONSTANTS.STATIC_FETCH)])
						: AbortSignal.timeout(TIMEOUT_CONSTANTS.STATIC_FETCH),
				allowLocalhostOnInitialRequest:
					this.localSeedUrl !== undefined && item.url === this.localSeedUrl,
			});
		} catch (error) {
			if (signal?.aborted) {
				throw signal.reason instanceof Error ? signal.reason : new Error("Fetch aborted");
			}
			this.logger.warn(
				`[Fetch] Transient fetch failure for ${item.url}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return {
				type: "transientFailure",
				statusCode: 0,
				retryAfterMs: RETRY_CONSTANTS.BASE_DELAY,
			};
		}
		if (signal?.aborted) {
			await disposeResponseBody(response);
			throw signal.reason instanceof Error ? signal.reason : new Error("Fetch aborted");
		}

		if (response.status === 304) {
			await disposeResponseBody(response);
			return {
				type: "blocked",
				statusCode: 304,
				reason: `Received unexpected 304 for unconditional request to ${item.url}`,
			};
		}
		const effectiveUrl = response.url || item.url;

		const classifiedStaticStatus = classifyFetchStatus(response.status, {
			retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
			blockedStatuses: [],
			blockedReason: `Access blocked for ${item.url}`,
		});
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
		const readContent = await readResponseContent(response, contentType);
		if (readContent.type === "tooLarge") {
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
			lastModified: response.headers.get("last-modified"),
			etag: response.headers.get("etag"),
			xRobotsTag: response.headers.get("x-robots-tag"),
			isDynamic: false,
		};
	}
}

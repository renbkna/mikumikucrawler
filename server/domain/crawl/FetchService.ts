import type { Logger } from "../../config/logging.js";
import {
	FETCH_HEADERS,
	RETRY_CONSTANTS,
	TIMEOUT_CONSTANTS,
} from "../../constants.js";
import type { HttpClient } from "../../plugins/security.js";
import { isPdfContentType } from "../../processors/contentTypes.js";
import type { PageRepo } from "../../storage/repos/pageRepo.js";
import type { QueueItem } from "./CrawlQueue.js";
import type { DynamicRenderer } from "./DynamicRenderer.js";
import {
	isAccessBlockedStatus,
	isPermanentFetchFailureStatus,
	isRateLimitedStatus,
} from "./httpStatusPolicy.js";

export type FetchResult =
	| {
			type: "success";
			content: string | Buffer;
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
			type: "unchanged";
			statusCode: 304;
			lastModified: string | null;
			etag: string | null;
	  }
	| {
			type: "rateLimited";
			statusCode: number;
			retryAfterMs: number;
	  }
	| {
			type: "permanentFailure";
			statusCode: number;
	  }
	| {
			type: "blocked";
			statusCode: number;
			reason?: string;
	  };

function parseRetryAfter(value: string | null): number {
	if (!value) return RETRY_CONSTANTS.MAX_DELAY;
	if (/^\d+$/.test(value.trim())) {
		return Math.min(
			Number.parseInt(value, 10) * 1000,
			RETRY_CONSTANTS.MAX_DELAY,
		);
	}

	const parsedDate = Date.parse(value);
	if (!Number.isNaN(parsedDate)) {
		return Math.min(
			Math.max(parsedDate - Date.now(), 0),
			RETRY_CONSTANTS.MAX_DELAY,
		);
	}

	return RETRY_CONSTANTS.MAX_DELAY;
}

function classifyFetchStatus(
	statusCode: number,
	options: {
		retryAfterMs?: number;
		blockedStatuses: readonly number[];
		blockedReason?: string;
	},
): Exclude<FetchResult, { type: "success" | "unchanged" }> | null {
	if (isRateLimitedStatus(statusCode)) {
		return {
			type: "rateLimited",
			statusCode,
			retryAfterMs: options.retryAfterMs ?? RETRY_CONSTANTS.MAX_DELAY,
		};
	}

	if (isPermanentFetchFailureStatus(statusCode)) {
		return {
			type: "permanentFailure",
			statusCode,
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
		private readonly pageRepo: PageRepo,
		private readonly httpClient: HttpClient,
		private readonly dynamicRenderer: DynamicRenderer,
		private readonly logger: Logger,
	) {}

	async fetch(
		crawlId: string,
		item: QueueItem,
		signal?: AbortSignal,
	): Promise<FetchResult> {
		let dynamicResult: Awaited<ReturnType<DynamicRenderer["render"]>> = null;
		if (this.dynamicRenderer.isEnabled()) {
			try {
				dynamicResult = await this.dynamicRenderer.render(item, signal);
			} catch (error) {
				if (signal?.aborted) {
					throw signal.reason instanceof Error
						? signal.reason
						: new Error("Fetch aborted");
				}
				this.logger.warn(
					`[Fetch] Dynamic render failed for ${item.url}; falling back to static crawl: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		if (signal?.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new Error("Fetch aborted");
		}

		if (dynamicResult) {
			if (signal?.aborted) {
				throw signal.reason instanceof Error
					? signal.reason
					: new Error("Fetch aborted");
			}
			if (dynamicResult.type === "consentBlocked") {
				this.logger.warn(dynamicResult.message);
				return {
					type: "blocked",
					statusCode: dynamicResult.statusCode,
					reason: dynamicResult.message,
				};
			}

			const renderedPage = dynamicResult.result;
			const classifiedDynamicStatus = classifyFetchStatus(
				renderedPage.statusCode,
				{
					retryAfterMs: parseRetryAfter(renderedPage.retryAfter ?? null),
					blockedStatuses: [],
					blockedReason: `Access blocked for ${item.url}`,
				},
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

			if (renderedPage.statusCode >= 400) {
				return {
					type: "permanentFailure",
					statusCode: renderedPage.statusCode,
				};
			}

			const contentLength = Buffer.byteLength(renderedPage.content, "utf8");

			return {
				type: "success",
				content: renderedPage.content,
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

		// Consent-sensitive domains should not silently degrade to static junk when
		// the dynamic path already proved access is blocked by an interstitial wall.
		this.logger.info(`[Fetch] Static crawl for ${item.url}`);
		const cachedHeaders = this.pageRepo.getHeaders(crawlId, item.url);
		const conditionalHeaders: Record<string, string> = {};

		if (cachedHeaders?.lastModified) {
			conditionalHeaders["If-Modified-Since"] = cachedHeaders.lastModified;
		}

		if (cachedHeaders?.etag) {
			conditionalHeaders["If-None-Match"] = cachedHeaders.etag;
		}

		const response = await this.httpClient.fetch({
			url: item.url,
			headers: {
				...FETCH_HEADERS,
				...conditionalHeaders,
			},
			signal:
				signal && "any" in AbortSignal
					? AbortSignal.any([
							signal,
							AbortSignal.timeout(TIMEOUT_CONSTANTS.STATIC_FETCH),
						])
					: AbortSignal.timeout(TIMEOUT_CONSTANTS.STATIC_FETCH),
		});
		if (signal?.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new Error("Fetch aborted");
		}

		if (response.status === 304) {
			return {
				type: "unchanged",
				statusCode: 304,
				lastModified: cachedHeaders?.lastModified ?? null,
				etag: cachedHeaders?.etag ?? null,
			};
		}

		const classifiedStaticStatus = classifyFetchStatus(response.status, {
			retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
			blockedStatuses: [],
			blockedReason: `Access blocked for ${item.url}`,
		});
		if (classifiedStaticStatus) {
			return classifiedStaticStatus;
		}

		if (isAccessBlockedStatus(response.status)) {
			return {
				type: "blocked",
				statusCode: response.status,
				reason: `Access blocked for ${item.url}`,
			};
		}

		if (!response.ok) {
			return {
				type: "permanentFailure",
				statusCode: response.status,
			};
		}

		const contentType = response.headers.get("content-type") ?? "";
		const content = isPdfContentType(contentType)
			? Buffer.from(await response.arrayBuffer())
			: await response.text();
		const contentLength =
			typeof content === "string"
				? Buffer.byteLength(content, "utf8")
				: content.byteLength;
		return {
			type: "success",
			content,
			statusCode: response.status,
			contentType,
			contentLength,
			title: "",
			description: "",
			lastModified: response.headers.get("last-modified"),
			etag: response.headers.get("etag"),
			xRobotsTag: response.headers.get("x-robots-tag"),
			isDynamic: false,
		};
	}
}

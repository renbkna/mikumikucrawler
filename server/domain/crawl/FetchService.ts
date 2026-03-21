import type { Logger } from "../../config/logging.js";
import {
	FETCH_HEADERS,
	RETRY_CONSTANTS,
	TIMEOUT_CONSTANTS,
} from "../../constants.js";
import type { HttpClient } from "../../plugins/security.js";
import type { QueueItem } from "./CrawlQueue.js";
import type { DynamicRenderer } from "./DynamicRenderer.js";

type PageRepo = ReturnType<
	typeof import("../../storage/repos/pageRepo.js")["createPageRepo"]
>;

export type FetchResult =
	| {
			type: "success";
			content: string;
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
		return Number.parseInt(value, 10) * 1000;
	}

	const parsedDate = Date.parse(value);
	if (!Number.isNaN(parsedDate)) {
		return Math.max(parsedDate - Date.now(), RETRY_CONSTANTS.MAX_DELAY);
	}

	return RETRY_CONSTANTS.MAX_DELAY;
}

export class FetchService {
	constructor(
		private readonly pageRepo: PageRepo,
		private readonly httpClient: HttpClient,
		private readonly dynamicRenderer: DynamicRenderer,
		private readonly logger: Logger,
	) {}

	async fetch(crawlId: string, item: QueueItem): Promise<FetchResult> {
		const dynamicResult = this.dynamicRenderer.isEnabled()
			? await this.dynamicRenderer.render(item)
			: null;

		if (dynamicResult) {
			if (dynamicResult.type === "consentBlocked") {
				this.logger.warn(dynamicResult.message);
				return {
					type: "blocked",
					statusCode: dynamicResult.statusCode,
					reason: dynamicResult.message,
				};
			}

			const renderedPage = dynamicResult.result;
			const contentLength =
				renderedPage.contentLength ||
				Buffer.byteLength(renderedPage.content, "utf8");

			return {
				type: "success",
				content: renderedPage.content,
				statusCode: renderedPage.statusCode,
				contentType: renderedPage.contentType,
				contentLength,
				title: renderedPage.title,
				description: renderedPage.description,
				lastModified: renderedPage.lastModified ?? null,
				etag: null,
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
			signal: AbortSignal.timeout(TIMEOUT_CONSTANTS.STATIC_FETCH),
		});

		if (response.status === 304) {
			return {
				type: "unchanged",
				statusCode: 304,
				lastModified: cachedHeaders?.lastModified ?? null,
				etag: cachedHeaders?.etag ?? null,
			};
		}

		if (response.status === 429 || response.status === 503) {
			return {
				type: "rateLimited",
				statusCode: response.status,
				retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
			};
		}

		if ([404, 410, 501].includes(response.status)) {
			return {
				type: "permanentFailure",
				statusCode: response.status,
			};
		}

		if (response.status === 403) {
			return {
				type: "blocked",
				statusCode: response.status,
			};
		}

		if (!response.ok) {
			throw new Error(`HTTP error ${response.status} for ${item.url}`);
		}

		const content = await response.text();
		return {
			type: "success",
			content,
			statusCode: response.status,
			contentType: response.headers.get("content-type") ?? "",
			contentLength: Number.parseInt(
				response.headers.get("content-length") ?? "0",
				10,
			),
			title: "",
			description: "",
			lastModified: response.headers.get("last-modified"),
			etag: response.headers.get("etag"),
			xRobotsTag: response.headers.get("x-robots-tag"),
			isDynamic: false,
		};
	}
}

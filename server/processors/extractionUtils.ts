import { URL } from "node:url";
import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import type {
	ExtractedLink,
	MediaInfo,
	PageMetadata,
} from "../../shared/types.js";
import type { LoggerLike } from "../types.js";
import { normalizeCanonicalHttpUrl } from "../../shared/url.js";
import { getErrorMessage } from "../utils/helpers.js";

/** Pre-compiled regex for downloadable file extensions */
const DOWNLOAD_EXTENSIONS = /\.(pdf|doc|docx|xls|xlsx|zip|rar)$/i;
const MAIN_CONTENT_NOISE_SELECTOR =
	"nav, header, footer, aside, .sidebar, .menu, .navigation, script, style, .ads, .advertisement";
const SUBSTANTIAL_MAIN_CONTENT_LENGTH = 100;
const BODY_FALLBACK_ADVANTAGE_LENGTH = 100;

type MainContentCandidateKind = "broad" | "focused";

interface MainContentSelector {
	selector: string;
	kind: MainContentCandidateKind;
}

interface MainContentCandidate {
	text: string;
	kind: MainContentCandidateKind;
	order: number;
}

interface StructuredData {
	jsonLd: Record<string, unknown>[];
	microdata: Record<string, unknown[]>;
	openGraph: Record<string, string>;
	twitterCards: Record<string, string>;
	schema: Record<string, unknown>;
}

function appendSchemaValue(existing: unknown, next: unknown): unknown {
	if (existing === undefined) {
		return next;
	}

	return Array.isArray(existing) ? [...existing, next] : [existing, next];
}

function appendSchemaArrayValue(existing: unknown, next: unknown): unknown[] {
	if (existing === undefined) {
		return [next];
	}

	return Array.isArray(existing) ? [...existing, next] : [existing, next];
}

function schemaTypesFrom(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.flatMap(schemaTypesFrom);
	}

	return typeof value === "string" && value.trim() ? [value] : [];
}

function jsonLdRecordsFrom(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) {
		return value.flatMap(jsonLdRecordsFrom);
	}

	if (typeof value === "object" && value !== null) {
		return [value as Record<string, unknown>];
	}

	return [];
}

function appendJsonLdRecord(
	structured: StructuredData,
	record: Record<string, unknown>,
): void {
	structured.jsonLd.push(record);
	for (const schemaType of schemaTypesFrom(record["@type"])) {
		structured.schema[schemaType] = appendSchemaValue(
			structured.schema[schemaType],
			record,
		);
	}
}

function resolveDocumentBase(
	cheerioInstance: CheerioAPI,
	baseUrl: string,
): string {
	const baseTagHref = cheerioInstance("base[href]").first().attr("href");
	if (!baseTagHref) {
		return baseUrl;
	}

	try {
		return new URL(baseTagHref, baseUrl).href;
	} catch {
		return baseUrl;
	}
}

function normalizeResolvedResourceUrl(url: URL): string | null {
	if (url.protocol === "data:") {
		return url.toString();
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return null;
	}

	const normalized = normalizeCanonicalHttpUrl(url.href);
	return "error" in normalized ? null : normalized.url;
}

function chooseMainContentCandidate(
	candidates: MainContentCandidate[],
	bodyText: string,
): string {
	const bestCandidate = [...candidates].sort((left, right) => {
		const lengthDifference = right.text.length - left.text.length;
		if (lengthDifference !== 0) {
			return lengthDifference;
		}

		if (left.kind !== right.kind) {
			return left.kind === "focused" ? -1 : 1;
		}

		return left.order - right.order;
	})[0];

	if (!bestCandidate) {
		return bodyText;
	}

	if (
		bestCandidate.kind === "broad" &&
		bestCandidate.text.length < SUBSTANTIAL_MAIN_CONTENT_LENGTH &&
		bodyText.length >=
			bestCandidate.text.length + BODY_FALLBACK_ADVANTAGE_LENGTH
	) {
		return bodyText;
	}

	return bestCandidate.text;
}

function cleanMetadataValue(value: string | undefined): string {
	return value?.trim() ?? "";
}

/**
 * Sanitizes text by removing redundant whitespace and trimming.
 */
export function cleanText(text: string | null | undefined): string {
	if (!text) return "";
	return text.replaceAll(/\s+/g, " ").trim();
}

/**
 * Extracts structured data (JSON-LD, Microdata, OG, Twitter) from HTML.
 *
 * @param cheerioInstance - Loaded HTML document
 */
export function extractStructuredData(
	cheerioInstance: CheerioAPI,
	logger?: LoggerLike,
): StructuredData {
	if (typeof cheerioInstance !== "function") {
		throw new TypeError(
			"Invalid Cheerio instance passed to extractStructuredData",
		);
	}

	const structured: StructuredData = {
		jsonLd: [],
		microdata: {},
		openGraph: {},
		twitterCards: {},
		schema: {},
	};

	cheerioInstance('script[type="application/ld+json"]').each(
		(_: number, element: Element) => {
			try {
				const html = cheerioInstance(element).html();
				if (html) {
					const jsonData = JSON.parse(html);
					for (const record of jsonLdRecordsFrom(jsonData)) {
						appendJsonLdRecord(structured, record);
					}
				}
			} catch (err) {
				logger?.debug(`Malformed JSON-LD: ${getErrorMessage(err)}`);
			}
		},
	);

	cheerioInstance('meta[property^="og:"]').each(
		(_: number, element: Element) => {
			const property = cheerioInstance(element).attr("property");
			const content = cheerioInstance(element).attr("content");
			if (property && content) {
				structured.openGraph[property.replace("og:", "")] = content;
			}
		},
	);

	cheerioInstance('meta[name^="twitter:"]').each(
		(_: number, element: Element) => {
			const name = cheerioInstance(element).attr("name");
			const content = cheerioInstance(element).attr("content");
			if (name && content) {
				structured.twitterCards[name.replace("twitter:", "")] = content;
			}
		},
	);

	cheerioInstance("[itemscope]").each((_: number, element: Element) => {
		const itemType = cheerioInstance(element).attr("itemtype");
		if (!itemType) return;

		const microItem = extractMicrodataItem(cheerioInstance, element);
		if (!structured.microdata[itemType]) {
			structured.microdata[itemType] = [];
		}
		structured.microdata[itemType].push(microItem);
		structured.schema[itemType] = appendSchemaArrayValue(
			structured.schema[itemType],
			microItem,
		);
	});

	return structured;
}

/**
 * Identifies the primary content body using common selectors or heuristic cloning.
 *
 * Checks for common CMS class names (WordPress, Ghost, etc.) and semantic tags first.
 *
 * @param cheerioInstance - Loaded HTML document
 * @returns Cleaned primary text content
 */
export function extractMainContent(cheerioInstance: CheerioAPI): string {
	if (typeof cheerioInstance !== "function") {
		throw new TypeError(
			"Invalid Cheerio instance passed to extractMainContent",
		);
	}

	let mainContent = "";
	const contentSelectors: MainContentSelector[] = [
		{ selector: "article", kind: "broad" },
		{ selector: '[role="main"]', kind: "focused" },
		{ selector: ".content", kind: "broad" },
		{ selector: ".post-content", kind: "focused" },
		{ selector: ".entry-content", kind: "focused" },
		{ selector: ".article-content", kind: "focused" },
		{ selector: "main", kind: "focused" },
		{ selector: "#content", kind: "focused" },
		{ selector: "#main", kind: "focused" },
		{ selector: ".main-content", kind: "focused" },
	];
	const candidates: MainContentCandidate[] = [];
	let candidateOrder = 0;

	for (const { selector, kind } of contentSelectors) {
		cheerioInstance(selector).each((_: number, element) => {
			const clonedElement = cheerioInstance(element).clone();
			clonedElement.find(MAIN_CONTENT_NOISE_SELECTOR).remove();
			const candidate = cleanText(clonedElement.text());
			if (candidate.length > 0) {
				candidates.push({
					text: candidate,
					kind,
					order: candidateOrder,
				});
			}
			candidateOrder += 1;
		});
	}

	const bodyClone = cheerioInstance("body").clone();
	bodyClone.find(MAIN_CONTENT_NOISE_SELECTOR).remove();
	mainContent = chooseMainContentCandidate(
		candidates,
		cleanText(bodyClone.text()),
	);

	return mainContent;
}

/**
 * Extracts image, video, and audio sources with associated metadata.
 *
 * @param cheerioInstance - Loaded HTML document
 * @param baseUrl - Base URL for resolving relative paths
 */
export function extractMediaInfo(
	cheerioInstance: CheerioAPI,
	baseUrl: string,
	logger?: LoggerLike,
): MediaInfo[] {
	if (typeof cheerioInstance !== "function") {
		throw new TypeError("Invalid Cheerio instance passed to extractMediaInfo");
	}

	const media: MediaInfo[] = [];
	const seenMedia = new Set<string>();
	const resolveBase = resolveDocumentBase(cheerioInstance, baseUrl);

	const pushMedia = (entry: MediaInfo): void => {
		const key = `${entry.type}:${entry.url}`;
		if (seenMedia.has(key)) {
			return;
		}

		seenMedia.add(key);
		media.push(entry);
	};

	const firstSrcsetUrl = (srcset: string): string | null => {
		const candidate = srcset.split(",")[0]?.trim().split(/\s+/)[0];
		return candidate || null;
	};

	cheerioInstance("img").each((_: number, element: Element) => {
		const src = cheerioInstance(element).attr("src");
		const alt = cheerioInstance(element).attr("alt") || "";
		const title = cheerioInstance(element).attr("title") || "";

		if (!src) return;

		try {
			const normalizedUrl = normalizeResolvedResourceUrl(
				new URL(src, resolveBase),
			);
			if (!normalizedUrl) return;
			pushMedia({
				type: "image",
				url: normalizedUrl,
				alt,
				title,
				width: cheerioInstance(element).attr("width"),
				height: cheerioInstance(element).attr("height"),
			});
		} catch (err) {
			logger?.debug(`Malformed image URL: ${getErrorMessage(err)}`);
		}
	});

	cheerioInstance("picture source[srcset]").each(
		(_: number, element: Element) => {
			const srcset = cheerioInstance(element).attr("srcset");
			if (!srcset) return;

			const src = firstSrcsetUrl(srcset);
			if (!src) return;

			try {
				const normalizedUrl = normalizeResolvedResourceUrl(
					new URL(src, resolveBase),
				);
				if (!normalizedUrl) return;
				pushMedia({ type: "image", url: normalizedUrl });
			} catch (err) {
				logger?.debug(`Malformed picture source URL: ${getErrorMessage(err)}`);
			}
		},
	);

	const pushMediaSource = (type: "audio" | "video", element: Element): void => {
		const src = cheerioInstance(element).attr("src");
		if (src) {
			try {
				const normalizedUrl = normalizeResolvedResourceUrl(
					new URL(src, resolveBase),
				);
				if (!normalizedUrl) return;
				pushMedia({ type, url: normalizedUrl });
			} catch (err) {
				logger?.debug(`Malformed ${type} URL: ${getErrorMessage(err)}`);
			}
		}
	};

	cheerioInstance("video[src], video source[src]").each(
		(_: number, element: Element) => {
			pushMediaSource("video", element);
		},
	);

	cheerioInstance("audio[src], audio source[src]").each(
		(_: number, element: Element) => {
			pushMediaSource("audio", element);
		},
	);

	return media;
}

/**
 * Parses and classifies hyperlinks into logical categories (social, download, etc).
 *
 * @param cheerioInstance - Loaded HTML document
 * @param baseUrl - Base URL for resolving relative paths
 */
export function processLinks(
	cheerioInstance: CheerioAPI,
	baseUrl: string,
	logger?: LoggerLike,
): ExtractedLink[] {
	if (typeof cheerioInstance !== "function") {
		throw new TypeError("Invalid Cheerio instance passed to processLinks");
	}

	const links: ExtractedLink[] = [];
	const linksByUrl = new Map<string, ExtractedLink>();

	// Honour <base href="..."> — if the document declares a base URL, all
	// relative links must be resolved against it, not against the page URL.
	const resolveBase = resolveDocumentBase(cheerioInstance, baseUrl);
	const pageOrigin = new URL(baseUrl).origin.toLowerCase();

	cheerioInstance("a[href]").each((_: number, element: Element) => {
		const href = cheerioInstance(element).attr("href");
		const text = cheerioInstance(element).text().trim();
		const title = cheerioInstance(element).attr("title") || "";
		const rel = (cheerioInstance(element).attr("rel") || "").toLowerCase();

		if (!href) return;

		// Per-link nofollow: rel="nofollow" and rel="ugc" both signal that the
		// site owner does not vouch for the linked page.
		const nofollow = /\bnofollow\b|\bugc\b/.test(rel);

		try {
			const url = new URL(href, resolveBase);
			const isInternal = url.origin.toLowerCase() === pageOrigin;
			const linkType = classifyLink(url, text);
			const normalizedUrl =
				url.protocol === "http:" || url.protocol === "https:"
					? normalizeCanonicalHttpUrl(url.href)
					: url.protocol === "mailto:" || url.protocol === "tel:"
						? { url: url.toString() }
						: { error: "Unsupported link scheme" };
			if ("error" in normalizedUrl || !normalizedUrl.url) return;
			const nextLink: ExtractedLink = {
				url: normalizedUrl.url,
				text,
				title,
				isInternal,
				type: linkType,
				domain: url.hostname,
				nofollow,
			};
			const existing = linksByUrl.get(normalizedUrl.url);
			if (existing) {
				existing.text = existing.text || nextLink.text;
				existing.title = existing.title || nextLink.title;
				existing.nofollow = Boolean(existing.nofollow && nextLink.nofollow);
				return;
			}

			linksByUrl.set(normalizedUrl.url, nextLink);
			links.push(nextLink);
		} catch (err) {
			logger?.debug(`Malformed link URL: ${getErrorMessage(err)}`);
		}
	});

	return links;
}

/**
 * Extracts page-level metadata (title, description, author, dates).
 *
 * @param cheerioInstance - Loaded HTML document
 */
export function extractMetadata(cheerioInstance: CheerioAPI): PageMetadata {
	if (typeof cheerioInstance !== "function") {
		throw new TypeError("Invalid Cheerio instance passed to extractMetadata");
	}

	const metadata: PageMetadata = {
		title: "",
		description: "",
		author: "",
		publishDate: "",
		modifiedDate: "",
		canonical: "",
		robots: "",
		viewport: "",
		charset: "",
		generator: "",
	};

	metadata.title =
		cheerioInstance("title").text().trim() ||
		cleanMetadataValue(
			cheerioInstance('meta[property="og:title"]').attr("content"),
		) ||
		cheerioInstance("h1").first().text().trim();

	metadata.description =
		cleanMetadataValue(
			cheerioInstance('meta[name="description"]').attr("content"),
		) ||
		cleanMetadataValue(
			cheerioInstance('meta[property="og:description"]').attr("content"),
		);

	metadata.author =
		cleanMetadataValue(
			cheerioInstance('meta[name="author"]').attr("content"),
		) ||
		cleanMetadataValue(
			cheerioInstance('meta[property="article:author"]').attr("content"),
		);

	metadata.publishDate =
		cleanMetadataValue(
			cheerioInstance('meta[property="article:published_time"]').attr(
				"content",
			),
		) || cleanMetadataValue(cheerioInstance("time[datetime]").attr("datetime"));

	metadata.modifiedDate = cleanMetadataValue(
		cheerioInstance('meta[property="article:modified_time"]').attr("content"),
	);

	metadata.canonical = cleanMetadataValue(
		cheerioInstance('link[rel="canonical"]').attr("href"),
	);
	metadata.robots = cleanMetadataValue(
		cheerioInstance('meta[name="robots"]').attr("content"),
	);
	metadata.viewport = cleanMetadataValue(
		cheerioInstance('meta[name="viewport"]').attr("content"),
	);
	metadata.charset = cleanMetadataValue(
		cheerioInstance("meta[charset]").attr("charset"),
	);
	metadata.generator = cleanMetadataValue(
		cheerioInstance('meta[name="generator"]').attr("content"),
	);

	return metadata;
}

/**
 * Recursive helper to extract properties from a microdata itemscope.
 */
function extractMicrodataItem(
	cheerioInstance: CheerioAPI,
	element: Element,
): Record<string, unknown> {
	const item: Record<string, unknown> = {};
	const children = cheerioInstance(element).find("[itemprop]").toArray();

	for (const child of children) {
		const closestScope = cheerioInstance(child).closest("[itemscope]")[0];
		if (closestScope !== element && closestScope !== child) {
			continue;
		}

		const prop = cheerioInstance(child).attr("itemprop");
		if (!prop) continue;

		const value = cheerioInstance(child).is("[itemscope]")
			? extractMicrodataItem(cheerioInstance, child)
			: cheerioInstance(child).attr("content") ||
				cheerioInstance(child).text().trim();

		const existing = item[prop];
		if (Array.isArray(existing)) {
			existing.push(value);
		} else if (existing) {
			item[prop] = [existing, value];
		} else {
			item[prop] = value;
		}
	}

	return item;
}

/**
 * Categorizes a URL based on its destination and anchor text.
 */
function classifyLink(url: URL, text: string): string {
	const href = url.href.toLowerCase();
	const linkText = text.toLowerCase();

	if (
		href.includes("facebook.com") ||
		href.includes("twitter.com") ||
		href.includes("linkedin.com") ||
		href.includes("instagram.com")
	) {
		return "social";
	}

	if (DOWNLOAD_EXTENSIONS.test(href)) {
		return "download";
	}

	if (href.startsWith("mailto:")) return "email";

	if (
		linkText.includes("home") ||
		linkText.includes("about") ||
		linkText.includes("contact") ||
		linkText.includes("menu")
	) {
		return "navigation";
	}

	return "content";
}

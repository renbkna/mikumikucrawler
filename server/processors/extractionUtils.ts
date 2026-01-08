import { URL } from "node:url";
import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import type { ExtractedLink, MediaInfo } from "../types.js";

/** Pre-compiled regex for downloadable file extensions */
const DOWNLOAD_EXTENSIONS = /\.(pdf|doc|docx|xls|xlsx|zip|rar)$/i;

interface StructuredData {
	jsonLd: unknown[];
	microdata: Record<string, unknown[]>;
	openGraph: Record<string, string>;
	twitterCards: Record<string, string>;
	schema: Record<string, unknown>;
}

interface PageMetadata {
	title: string;
	description: string;
	author: string;
	publishDate: string;
	modifiedDate: string;
	canonical: string;
	robots: string;
	viewport: string;
	charset: string;
	generator: string;
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
					structured.jsonLd.push(jsonData);
				}
			} catch (err) {
				// Malformed JSON-LD is common on third-party sites; log for debugging
				console.debug(
					`Malformed JSON-LD: ${err instanceof Error ? err.message : err}`,
				);
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
	const contentSelectors = [
		"article",
		'[role="main"]',
		".content",
		".post-content",
		".entry-content",
		".article-content",
		"main",
		"#content",
		"#main",
		".main-content",
	];

	for (const selector of contentSelectors) {
		const element = cheerioInstance(selector).first();
		if (element.length && element.text().trim().length > 100) {
			mainContent = cleanText(element.text());
			break;
		}
	}

	if (!mainContent) {
		const bodyClone = cheerioInstance("body").clone();
		bodyClone
			.find(
				"nav, header, footer, aside, .sidebar, .menu, .navigation, script, style, .ads, .advertisement",
			)
			.remove();

		mainContent = cleanText(bodyClone.text());
	}

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
): MediaInfo[] {
	if (typeof cheerioInstance !== "function") {
		throw new TypeError("Invalid Cheerio instance passed to extractMediaInfo");
	}

	const media: MediaInfo[] = [];

	cheerioInstance("img").each((_: number, element: Element) => {
		const src = cheerioInstance(element).attr("src");
		const alt = cheerioInstance(element).attr("alt") || "";
		const title = cheerioInstance(element).attr("title") || "";

		if (!src) return;

		try {
			const absoluteUrl = new URL(src, baseUrl).href;
			media.push({
				type: "image",
				url: absoluteUrl,
				alt,
				title,
				width: cheerioInstance(element).attr("width"),
				height: cheerioInstance(element).attr("height"),
			});
		} catch (err) {
			// Malformed URLs are common in user content
			console.debug(
				`Malformed image URL: ${err instanceof Error ? err.message : err}`,
			);
		}
	});

	cheerioInstance("video source").each((_: number, element: Element) => {
		const src = cheerioInstance(element).attr("src");
		if (src) {
			try {
				const absoluteUrl = new URL(src, baseUrl).href;
				media.push({ type: "video", url: absoluteUrl });
			} catch (err) {
				console.debug(
					`Malformed video URL: ${err instanceof Error ? err.message : err}`,
				);
			}
		}
	});

	cheerioInstance("audio source").each((_: number, element: Element) => {
		const src = cheerioInstance(element).attr("src");
		if (src) {
			try {
				const absoluteUrl = new URL(src, baseUrl).href;
				media.push({ type: "audio", url: absoluteUrl });
			} catch (err) {
				console.debug(
					`Malformed audio URL: ${err instanceof Error ? err.message : err}`,
				);
			}
		}
	});

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
): ExtractedLink[] {
	if (typeof cheerioInstance !== "function") {
		throw new TypeError("Invalid Cheerio instance passed to processLinks");
	}

	const links: ExtractedLink[] = [];
	const baseHost = new URL(baseUrl).hostname;

	cheerioInstance("a[href]").each((_: number, element: Element) => {
		const href = cheerioInstance(element).attr("href");
		const text = cheerioInstance(element).text().trim();
		const title = cheerioInstance(element).attr("title") || "";

		if (!href) return;

		try {
			const url = new URL(href, baseUrl);
			const isInternal = url.hostname === baseHost;
			const linkType = classifyLink(url, text);

			links.push({
				url: url.href,
				text,
				title,
				isInternal,
				type: linkType,
				domain: url.hostname,
			});
		} catch (err) {
			console.debug(
				`Malformed link URL: ${err instanceof Error ? err.message : err}`,
			);
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
		cheerioInstance('meta[property="og:title"]').attr("content") ||
		cheerioInstance("h1").first().text().trim();

	metadata.description =
		cheerioInstance('meta[name="description"]').attr("content") ||
		cheerioInstance('meta[property="og:description"]').attr("content") ||
		"";

	metadata.author =
		cheerioInstance('meta[name="author"]').attr("content") ||
		cheerioInstance('meta[property="article:author"]').attr("content") ||
		"";

	metadata.publishDate =
		cheerioInstance('meta[property="article:published_time"]').attr(
			"content",
		) ||
		cheerioInstance("time[datetime]").attr("datetime") ||
		"";

	metadata.modifiedDate =
		cheerioInstance('meta[property="article:modified_time"]').attr("content") ||
		"";

	metadata.canonical =
		cheerioInstance('link[rel="canonical"]').attr("href") || "";
	metadata.robots =
		cheerioInstance('meta[name="robots"]').attr("content") || "";
	metadata.viewport =
		cheerioInstance('meta[name="viewport"]').attr("content") || "";
	metadata.charset = cheerioInstance("meta[charset]").attr("charset") || "";
	metadata.generator =
		cheerioInstance('meta[name="generator"]').attr("content") || "";

	return metadata;
}

/**
 * Recursive helper to extract properties from a microdata itemscope.
 */
function extractMicrodataItem(
	cheerioInstance: CheerioAPI,
	element: Element,
): Record<string, string | string[]> {
	const item: Record<string, string | string[]> = {};
	const children = cheerioInstance(element).find("[itemprop]").toArray();

	children.forEach((child: Element) => {
		const prop = cheerioInstance(child).attr("itemprop");
		const value =
			cheerioInstance(child).attr("content") ||
			cheerioInstance(child).text().trim();

		if (!prop) return;

		const existing = item[prop];
		if (Array.isArray(existing)) {
			existing.push(value);
		} else if (existing) {
			item[prop] = [existing, value];
		} else {
			item[prop] = value;
		}
	});

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

import { URL } from "node:url";
import type { CheerioAPI } from "cheerio";
import { PAGE_TEXT_LIMITS, type PageMetadata } from "../../shared/contracts/pageData.js";
import { truncateUtf8Text } from "../../shared/text.js";
import { normalizeCanonicalHttpUrl } from "../../shared/url.js";
import type { ExtractedLink, LoggerLike } from "../types.js";
import { getErrorMessage } from "../utils/helpers.js";

const MAIN_CONTENT_NOISE_SELECTOR =
	"nav, header, footer, aside, .sidebar, .menu, .navigation, script, style, .ads, .advertisement";
const SUBSTANTIAL_MAIN_CONTENT_LENGTH = 100;
const BODY_FALLBACK_ADVANTAGE_LENGTH = 100;
const MAX_MAIN_CONTENT_DOM_NODES = 50_000;
const MAX_MAIN_CONTENT_DOM_DEPTH = 128;
const MAX_MEDIA_CANDIDATES = 1_000;
export const MAX_EXTRACTED_LINKS_PER_PAGE = 1_000;

type MainContentCandidateKind = "broad" | "focused";

interface MainContentCandidate {
	text: string;
	kind: MainContentCandidateKind;
}

function resolveDocumentBase(cheerioInstance: CheerioAPI, baseUrl: string): string {
	const baseTagHref = cheerioInstance("base[href]").first().attr("href");
	if (!baseTagHref) return baseUrl;
	try {
		return new URL(baseTagHref, baseUrl).href;
	} catch {
		return baseUrl;
	}
}

function normalizeResolvedResourceUrl(url: URL): string | null {
	if (url.protocol === "data:") return url.toString();
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	const normalized = normalizeCanonicalHttpUrl(url.href);
	return "error" in normalized ? null : normalized.url;
}

function chooseMainContentCandidate(
	bestCandidate: MainContentCandidate | undefined,
	bodyText: string,
): string {
	if (!bestCandidate) return bodyText;
	if (
		bestCandidate.kind === "broad" &&
		bestCandidate.text.length < SUBSTANTIAL_MAIN_CONTENT_LENGTH &&
		bodyText.length >= bestCandidate.text.length + BODY_FALLBACK_ADVANTAGE_LENGTH
	) {
		return bodyText;
	}
	return bestCandidate.text;
}

function cleanMetadataValue(value: string | undefined): string {
	return truncateUtf8Text(value?.trim() ?? "", PAGE_TEXT_LIMITS.metadataValueBytes);
}

export function cleanText(text: string | null | undefined): string {
	return text ? text.replaceAll(/\s+/g, " ").trim() : "";
}

export function extractMainContent(cheerioInstance: CheerioAPI): string {
	const body = cheerioInstance("body").first()[0];
	if (!body) return "";

	let visitedNodes = 0;
	type BodyNode = typeof body | (typeof body.children)[number];
	const stack: Array<{ node: BodyNode; depth: number }> = [{ node: body, depth: 0 }];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) break;
		visitedNodes += 1;
		if (visitedNodes > MAX_MAIN_CONTENT_DOM_NODES) {
			throw new Error(`HTML main-content DOM exceeds ${MAX_MAIN_CONTENT_DOM_NODES} nodes`);
		}
		if (current.depth > MAX_MAIN_CONTENT_DOM_DEPTH) {
			throw new Error(`HTML main-content DOM exceeds depth ${MAX_MAIN_CONTENT_DOM_DEPTH}`);
		}
		if (!("children" in current.node)) continue;
		for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
			const child = current.node.children[index];
			if (child) stack.push({ node: child, depth: current.depth + 1 });
		}
	}

	const bodyClone = cheerioInstance(body).clone();
	bodyClone.find(MAIN_CONTENT_NOISE_SELECTOR).remove();
	let bestCandidate: MainContentCandidate | undefined;
	const selectors: Array<{ selector: string; kind: MainContentCandidateKind }> = [
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
	for (const { selector, kind } of selectors) {
		bodyClone.find(selector).each((_, element) => {
			const text = cleanText(cheerioInstance(element).text());
			if (
				text &&
				(!bestCandidate ||
					text.length > bestCandidate.text.length ||
					(text.length === bestCandidate.text.length &&
						kind === "focused" &&
						bestCandidate.kind === "broad"))
			) {
				bestCandidate = { text, kind };
			}
		});
	}

	return chooseMainContentCandidate(bestCandidate, cleanText(bodyClone.text()));
}

export function extractMediaCount(
	cheerioInstance: CheerioAPI,
	baseUrl: string,
	logger?: LoggerLike,
): number {
	const media = new Set<string>();
	const resolveBase = resolveDocumentBase(cheerioInstance, baseUrl);
	let examined = 0;
	const add = (type: "image" | "video" | "audio", source: string | undefined): void => {
		if (!source || examined >= MAX_MEDIA_CANDIDATES) return;
		examined += 1;
		try {
			const normalized = normalizeResolvedResourceUrl(new URL(source, resolveBase));
			if (normalized) media.add(`${type}:${normalized}`);
		} catch (error) {
			logger?.debug(`Malformed ${type} URL: ${getErrorMessage(error)}`);
		}
	};
	const addSrcset = (srcset: string | undefined): void => {
		let position = 0;
		while (srcset && position < srcset.length && examined < MAX_MEDIA_CANDIDATES) {
			while (position < srcset.length && /[\s,]/.test(srcset[position] ?? "")) position += 1;
			const start = position;
			while (position < srcset.length && !/\s/.test(srcset[position] ?? "")) position += 1;
			let end = position;
			while (end > start && srcset[end - 1] === ",") end -= 1;
			if (end > start) add("image", srcset.slice(start, end));
			if (end < position) continue;
			while (position < srcset.length && srcset[position] !== ",") position += 1;
			position += 1;
		}
	};

	cheerioInstance("img").each((_, element) => {
		if (examined >= MAX_MEDIA_CANDIDATES) return false;
		add("image", cheerioInstance(element).attr("src"));
		addSrcset(cheerioInstance(element).attr("srcset"));
		return undefined;
	});
	cheerioInstance("picture source[srcset]").each((_, element) => {
		if (examined >= MAX_MEDIA_CANDIDATES) return false;
		addSrcset(cheerioInstance(element).attr("srcset"));
		return undefined;
	});
	cheerioInstance("video[src], video source[src]").each((_, element) => {
		if (examined >= MAX_MEDIA_CANDIDATES) return false;
		add("video", cheerioInstance(element).attr("src"));
		return undefined;
	});
	cheerioInstance("audio[src], audio source[src]").each((_, element) => {
		if (examined >= MAX_MEDIA_CANDIDATES) return false;
		add("audio", cheerioInstance(element).attr("src"));
		return undefined;
	});
	return media.size;
}

export function processLinks(
	cheerioInstance: CheerioAPI,
	baseUrl: string,
	logger?: LoggerLike,
): ExtractedLink[] {
	const links = new Map<string, ExtractedLink>();
	const resolveBase = resolveDocumentBase(cheerioInstance, baseUrl);
	let examined = 0;
	cheerioInstance("a[href]").each((_, element) => {
		if (examined >= MAX_EXTRACTED_LINKS_PER_PAGE) return false;
		examined += 1;
		const href = cheerioInstance(element).attr("href");
		if (!href) return undefined;
		try {
			const normalized = normalizeCanonicalHttpUrl(new URL(href, resolveBase).href);
			if ("error" in normalized) return undefined;
			const nofollow = /\bnofollow\b|\bugc\b/.test(
				(cheerioInstance(element).attr("rel") ?? "").toLowerCase(),
			);
			const existing = links.get(normalized.url);
			links.set(normalized.url, {
				url: normalized.url,
				nofollow: existing ? Boolean(existing.nofollow && nofollow) : nofollow,
			});
		} catch (error) {
			logger?.debug(`Malformed link URL: ${getErrorMessage(error)}`);
		}
		return undefined;
	});
	if (examined >= MAX_EXTRACTED_LINKS_PER_PAGE) {
		logger?.debug(`Link extraction stopped at ${MAX_EXTRACTED_LINKS_PER_PAGE} candidates`);
	}
	return [...links.values()];
}

export function extractMetadata(cheerioInstance: CheerioAPI): PageMetadata {
	return {
		title: truncateUtf8Text(
			cheerioInstance("title").text().trim() ||
				cleanMetadataValue(cheerioInstance('meta[property="og:title"]').attr("content")) ||
				cheerioInstance("h1").first().text().trim(),
			PAGE_TEXT_LIMITS.metadataValueBytes,
		),
		description:
			cleanMetadataValue(cheerioInstance('meta[name="description"]').attr("content")) ||
			cleanMetadataValue(cheerioInstance('meta[property="og:description"]').attr("content")),
		robots: cleanMetadataValue(cheerioInstance('meta[name="robots"]').attr("content")),
	};
}

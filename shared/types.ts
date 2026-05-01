import type { CrawlOptions } from "./contracts/crawl.js";

/**
 * Shared runtime-facing types used by both the React client and Bun server.
 * These live outside `src/` so neither runtime depends on the other's module
 * tree for cross-boundary contracts.
 */
export interface ExtractedLink {
	url: string;
	text?: string;
	title?: string;
	isInternal?: boolean;
	type?: string;
	domain?: string;
	/** True when the anchor element carries rel="nofollow" or rel="ugc". */
	nofollow?: boolean;
}

export interface MediaInfo {
	type: "image" | "video" | "audio";
	url: string;
	alt?: string;
	title?: string;
	width?: string;
	height?: string;
	poster?: string;
}

export interface ProcessingError {
	type: string;
	message: string;
	timestamp?: string;
}

export interface QualityAnalysis {
	score: number;
	factors: Record<string, number | boolean>;
	issues: string[];
}

export interface ContentAnalysis {
	wordCount?: number;
	readingTime?: number;
	language?: string;
	keywords?: Array<{ word: string; count: number }>;
	sentiment?: string;
	readabilityScore?: number;
	quality?: QualityAnalysis;
}

export interface ExtractedData {
	mainContent?: string;
	jsonLd?: Record<string, unknown>[];
	microdata?: Record<string, unknown>;
	openGraph?: Record<string, string>;
	twitterCards?: Record<string, string>;
	schema?: Record<string, unknown>;
}

export interface PageMetadata {
	title?: string;
	description?: string;
	author?: string;
	publishDate?: string;
	modifiedDate?: string;
	canonical?: string;
	robots?: string;
	viewport?: string;
	charset?: string;
	generator?: string;
	[key: string]: string | undefined;
}

export interface ProcessedPageData {
	extractedData: ExtractedData;
	metadata: PageMetadata;
	analysis: ContentAnalysis;
	media: MediaInfo[];
	errors?: ProcessingError[];
	qualityScore: number;
	language: string;
}

export interface Stats {
	pagesScanned: number;
	linksFound: number;
	totalData: number;
	mediaFiles: number;
	successCount: number;
	failureCount: number;
	skippedCount: number;
	elapsedTime?: {
		hours: number;
		minutes: number;
		seconds: number;
	};
	pagesPerSecond?: number | string;
	successRate?: string;
	lastProcessed?: {
		url: string;
		wordCount: number;
		qualityScore: number;
		language: string;
		mediaCount: number;
		linksCount: number;
	};
}

export interface QueueStats {
	activeRequests: number;
	queueLength: number;
	elapsedTime: number;
	pagesPerSecond: number;
}

export type { CrawlOptions };

export interface CrawledPage {
	id: number | null;
	url: string;
	content?: string;
	title?: string;
	description?: string;
	contentType?: string;
	domain?: string;
	processedData?: ProcessedPageData;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
	return isFiniteNumber(value) && Number.isInteger(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return isFiniteNumber(value) && value >= 0;
}

function isStringOrUndefined(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
	return Array.isArray(value) && value.every(isRecord);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		isRecord(value) &&
		Object.values(value).every((entry) => typeof entry === "string")
	);
}

function isPageMetadata(value: unknown): value is PageMetadata {
	return (
		isRecord(value) &&
		Object.values(value).every(
			(entry) => entry === undefined || typeof entry === "string",
		)
	);
}

function isQualityAnalysis(value: unknown): value is QualityAnalysis {
	return (
		isRecord(value) &&
		isFiniteNumber(value.score) &&
		isRecord(value.factors) &&
		Object.values(value.factors).every(
			(entry) => typeof entry === "number" || typeof entry === "boolean",
		) &&
		Array.isArray(value.issues) &&
		value.issues.every((entry) => typeof entry === "string")
	);
}

function isContentAnalysis(value: unknown): value is ContentAnalysis {
	return (
		isRecord(value) &&
		(value.wordCount === undefined ||
			isNonNegativeFiniteNumber(value.wordCount)) &&
		(value.readingTime === undefined ||
			isNonNegativeFiniteNumber(value.readingTime)) &&
		isStringOrUndefined(value.language) &&
		(value.keywords === undefined ||
			(Array.isArray(value.keywords) &&
				value.keywords.every(
					(entry) =>
						isRecord(entry) &&
						typeof entry.word === "string" &&
						isNonNegativeFiniteNumber(entry.count),
				))) &&
		isStringOrUndefined(value.sentiment) &&
		(value.readabilityScore === undefined ||
			isFiniteNumber(value.readabilityScore)) &&
		(value.quality === undefined || isQualityAnalysis(value.quality))
	);
}

function isExtractedData(value: unknown): value is ExtractedData {
	return (
		isRecord(value) &&
		isStringOrUndefined(value.mainContent) &&
		(value.jsonLd === undefined || isRecordArray(value.jsonLd)) &&
		(value.microdata === undefined || isRecord(value.microdata)) &&
		(value.openGraph === undefined || isStringRecord(value.openGraph)) &&
		(value.twitterCards === undefined || isStringRecord(value.twitterCards)) &&
		(value.schema === undefined || isRecord(value.schema))
	);
}

function isMediaInfo(value: unknown): value is MediaInfo {
	return (
		isRecord(value) &&
		(value.type === "image" ||
			value.type === "video" ||
			value.type === "audio") &&
		typeof value.url === "string" &&
		isStringOrUndefined(value.alt) &&
		isStringOrUndefined(value.title) &&
		isStringOrUndefined(value.width) &&
		isStringOrUndefined(value.height) &&
		isStringOrUndefined(value.poster)
	);
}

function isProcessingError(value: unknown): value is ProcessingError {
	return (
		isRecord(value) &&
		typeof value.type === "string" &&
		typeof value.message === "string" &&
		isStringOrUndefined(value.timestamp)
	);
}

export function isProcessedPageData(
	value: unknown,
): value is ProcessedPageData {
	return (
		isRecord(value) &&
		isExtractedData(value.extractedData) &&
		isPageMetadata(value.metadata) &&
		isContentAnalysis(value.analysis) &&
		Array.isArray(value.media) &&
		value.media.every(isMediaInfo) &&
		(value.errors === undefined ||
			(Array.isArray(value.errors) && value.errors.every(isProcessingError))) &&
		isFiniteNumber(value.qualityScore) &&
		typeof value.language === "string"
	);
}

export function isCrawledPage(value: unknown): value is CrawledPage {
	return (
		isRecord(value) &&
		(value.id === null || isInteger(value.id)) &&
		typeof value.url === "string" &&
		isStringOrUndefined(value.content) &&
		isStringOrUndefined(value.title) &&
		isStringOrUndefined(value.description) &&
		isStringOrUndefined(value.contentType) &&
		isStringOrUndefined(value.domain) &&
		(value.processedData === undefined ||
			isProcessedPageData(value.processedData))
	);
}

export function isQueueStats(value: unknown): value is QueueStats {
	return (
		isRecord(value) &&
		isNonNegativeFiniteNumber(value.activeRequests) &&
		isNonNegativeFiniteNumber(value.queueLength) &&
		isNonNegativeFiniteNumber(value.elapsedTime) &&
		isNonNegativeFiniteNumber(value.pagesPerSecond)
	);
}

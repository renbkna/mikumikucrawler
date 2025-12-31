/// <reference path="../types/sentiment.d.ts" />
import type { CheerioAPI } from "cheerio";
import languageDetect from "languagedetect";
import Sentiment from "sentiment";

const lngDetector = new languageDetect();
const sentiment = new Sentiment();

interface AnalysisResult {
	wordCount: number;
	readingTime: number;
	language: string;
	keywords: Array<{ word: string; count: number }>;
	sentiment: string;
	readabilityScore: number;
	quality: {
		score: number;
		factors: Record<string, number | boolean>;
		issues: string[];
	};
}

interface QualityResult {
	score: number;
	factors: Record<string, number | boolean>;
	issues: string[];
}

const STOP_WORDS: Record<string, Set<string>> = {
	en: new Set([
		"the",
		"a",
		"an",
		"is",
		"are",
		"was",
		"were",
		"be",
		"been",
		"being",
		"have",
		"has",
		"had",
		"do",
		"does",
		"did",
		"will",
		"would",
		"could",
		"should",
		"may",
		"might",
		"must",
		"shall",
		"can",
		"need",
		"dare",
		"ought",
		"used",
		"to",
		"of",
		"in",
		"for",
		"on",
		"with",
		"at",
		"by",
		"from",
		"as",
		"into",
		"through",
		"during",
		"before",
		"after",
		"above",
		"below",
		"between",
		"under",
		"again",
		"further",
		"then",
		"once",
		"here",
		"there",
		"when",
		"where",
		"why",
		"how",
		"all",
		"each",
		"few",
		"more",
		"most",
		"other",
		"some",
		"such",
		"no",
		"nor",
		"not",
		"only",
		"own",
		"same",
		"so",
		"than",
		"too",
		"very",
		"just",
		"but",
		"and",
		"or",
		"if",
		"because",
		"until",
		"while",
		"this",
		"that",
		"these",
		"those",
		"what",
		"which",
		"who",
		"whom",
		"whose",
		"it",
		"its",
		"i",
		"me",
		"my",
		"myself",
		"we",
		"our",
		"ours",
		"ourselves",
		"you",
		"your",
		"yours",
		"yourself",
		"yourselves",
		"he",
		"him",
		"his",
		"himself",
		"she",
		"her",
		"hers",
		"herself",
		"they",
		"them",
		"their",
		"theirs",
		"themselves",
		"about",
		"also",
		"am",
		"any",
	]),
	es: new Set([
		"el",
		"la",
		"los",
		"las",
		"un",
		"una",
		"unos",
		"unas",
		"de",
		"en",
		"con",
		"por",
		"para",
		"que",
		"como",
		"pero",
		"si",
		"no",
		"es",
		"son",
		"fue",
		"era",
		"eran",
		"ser",
		"estar",
		"tiene",
		"tienen",
		"y",
		"o",
		"a",
		"del",
		"al",
		"lo",
	]),
	fr: new Set([
		"le",
		"la",
		"les",
		"un",
		"une",
		"des",
		"de",
		"du",
		"en",
		"et",
		"est",
		"sont",
		"a",
		"ont",
		"avec",
		"pour",
		"que",
		"qui",
		"dans",
		"sur",
		"par",
		"pas",
		"ne",
		"ce",
		"cette",
		"ces",
		"il",
		"elle",
		"ils",
		"elles",
		"nous",
		"vous",
		"je",
		"tu",
		"ou",
		"mais",
		"si",
	]),
	de: new Set([
		"der",
		"die",
		"das",
		"ein",
		"eine",
		"und",
		"ist",
		"sind",
		"war",
		"waren",
		"von",
		"mit",
		"zu",
		"auf",
		"in",
		"den",
		"dem",
		"des",
		"es",
		"er",
		"sie",
		"wir",
		"ihr",
		"ich",
		"du",
		"nicht",
		"als",
		"auch",
		"an",
		"aber",
		"oder",
		"wenn",
		"noch",
		"wie",
		"so",
		"nur",
		"nach",
		"bei",
		"aus",
		"um",
		"am",
		"im",
	]),
};

const DEFAULT_STOP_WORDS = STOP_WORDS.en;

/** Analyzes text to determine word count, language, sentiment, and readability. */
export function analyzeContent(text: string): AnalysisResult {
	const cleanText = (text || "").toString().trim();
	const words = cleanText.split(/\s+/).filter((w) => w.length > 0);
	const wordCount = words.length;
	const readingTime = Math.ceil(wordCount / 200);

	let language = "en";
	try {
		const detected = lngDetector.detect(cleanText, 1);
		if (detected && detected.length > 0) {
			language = detected[0][0] || "en";
		}
	} catch {
		language = "en";
	}

	const stopWords = STOP_WORDS[language] || DEFAULT_STOP_WORDS;
	const wordFreq: Record<string, number> = {};
	words.forEach((word) => {
		const lower = word.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
		if (lower.length > 2 && !stopWords.has(lower)) {
			wordFreq[lower] = (wordFreq[lower] || 0) + 1;
		}
	});

	const keywords = Object.entries(wordFreq)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([word, count]) => ({ word, count }));

	let sentimentLabel = "neutral";
	try {
		const result = sentiment.analyze(cleanText);
		// Heuristic thresholds: +/- 2 allows for some mild sentiment words without skewing the result.
		if (result.score > 2) sentimentLabel = "positive";
		else if (result.score < -2) sentimentLabel = "negative";
	} catch {
		sentimentLabel = "neutral";
	}

	const sentences = cleanText
		.split(/[.!?]+/)
		.filter((s) => s.trim().length > 0);
	const avgWordsPerSentence =
		sentences.length > 0 ? wordCount / sentences.length : 0;
	const syllableCount = words.reduce(
		(sum, word) => sum + countSyllables(word),
		0,
	);
	const avgSyllablesPerWord = wordCount > 0 ? syllableCount / wordCount : 0;
	// Flesch Reading Ease formula
	const readabilityScore = Math.max(
		0,
		Math.min(
			100,
			206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord,
		),
	);

	return {
		wordCount,
		readingTime,
		language,
		keywords,
		sentiment: sentimentLabel,
		readabilityScore: Math.round(readabilityScore),
		quality: {
			score: 0,
			factors: {},
			issues: [],
		},
	};
}

/**
 * Detects the syllable count in a word using heuristic vowel pattern matching.
 * NOTE: This is an approximation (English-centric), not a dictionary lookup.
 */
function countSyllables(word: string): number {
	word = word.toLowerCase().replaceAll(/[^a-z]/g, "");
	if (word.length <= 3) return 1;

	word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
	word = word.replace(/^y/, "");

	const matches = word.match(/[aeiouy]{1,2}/g);
	return matches ? matches.length : 1;
}

/**
 * Assesses page quality based on metadata presence, content length, and accessibility markers.
 *
 * Uses a baseline score of 50 and penalizes/rewards based on key SEO/UX factors.
 * This is a heuristic scoring system, not a definitive quality metric.
 *
 * @param cheerioInstance - Loaded HTML document
 * @param mainContent - Primary extracted text body
 * @returns Object containing quality score (0-100), factors checked, and identified issues.
 */
export function assessContentQuality(
	cheerioInstance: CheerioAPI,
	mainContent: string,
): QualityResult {
	const factors: Record<string, number | boolean> = {};
	const issues: string[] = [];
	let score = 50;

	const title = cheerioInstance("title").text().trim();
	factors.hasTitle = title.length > 0;
	if (!factors.hasTitle) {
		issues.push("Missing page title");
		score -= 10;
	} else if (title.length < 10) {
		issues.push("Title too short");
		score -= 5;
	}

	const description =
		cheerioInstance('meta[name="description"]').attr("content") || "";
	factors.hasDescription = description.length > 0;
	if (!factors.hasDescription) {
		issues.push("Missing meta description");
		score -= 10;
	} else if (description.length < 50) {
		issues.push("Meta description too short");
		score -= 5;
	}

	const contentLength = mainContent.length;
	factors.contentLength = contentLength;
	if (contentLength < 300) {
		issues.push("Content too thin");
		score -= 15;
	} else if (contentLength > 1000) {
		score += 10;
	}

	const headingsCount = cheerioInstance("h1, h2, h3").length;
	factors.hasHeadings = headingsCount > 0;
	if (factors.hasHeadings) {
		score += Math.min(10, headingsCount * 2);
	} else {
		issues.push("No headings found");
		score -= 5;
	}

	const imagesCount = cheerioInstance("img").length;
	factors.hasImages = imagesCount > 0;
	if (factors.hasImages) {
		score += 5;
		const imagesWithAlt = cheerioInstance("img[alt]").length;
		factors.imagesWithAlt = imagesWithAlt;
		if (imagesWithAlt < imagesCount) {
			issues.push("Some images missing alt attributes");
		}
	}

	const linksCount = cheerioInstance("a[href]").length;
	factors.hasLinks = linksCount > 0;
	if (linksCount > 0) {
		score += 5;
	}

	score = Math.max(0, Math.min(100, score));

	return {
		score,
		factors,
		issues,
	};
}

interface JSONProcessResult {
	data?: unknown;
	keys?: string[];
	raw?: string;
	error?: string;
	structure?: string;
}

/** Parses and analyzes JSON content structure. */
export function processJSON(content: string): JSONProcessResult {
	try {
		const data = JSON.parse(content);
		const analysis: JSONProcessResult = {
			data,
			keys: Object.keys(data).slice(0, 20),
			raw: content.substring(0, 500),
		};

		if (Array.isArray(data)) {
			analysis.structure = `Array with ${data.length} items`;
		} else if (typeof data === "object") {
			analysis.structure = `Object with ${Object.keys(data).length} keys`;
		}

		return analysis;
	} catch {
		return {
			error: "Invalid JSON",
			raw: content.substring(0, 500),
		};
	}
}

// Type declarations for modules without built-in types

declare module "languagedetect" {
	class LanguageDetect {
		detect(text: string, limit?: number): Array<[string, number]>;
	}
	export = LanguageDetect;
}

declare module "sentiment" {
	interface SentimentResult {
		score: number;
		comparative: number;
		calculation: Array<{ [word: string]: number }>;
		tokens: string[];
		words: string[];
		positive: string[];
		negative: string[];
	}

	class Sentiment {
		analyze(text: string): SentimentResult;
	}

	export = Sentiment;
}

declare module "robots-parser" {
	interface RobotsParser {
		isAllowed(url: string, userAgent?: string): boolean;
		isDisallowed(url: string, userAgent?: string): boolean;
		getCrawlDelay(userAgent?: string): number | undefined;
		getSitemaps(): string[];
	}

	function robotsParser(robotsTxtUrl: string, robotsTxt: string): RobotsParser;
	export = robotsParser;
}

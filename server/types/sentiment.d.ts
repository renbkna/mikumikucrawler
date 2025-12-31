declare module "sentiment" {
	interface SentimentResult {
		score: number;
		comparative: number;
		calculation: Array<{ [key: string]: number }>;
		tokens: string[];
		words: string[];
		positive: string[];
		negative: string[];
	}

	interface SentimentOptions {
		extras?: { [key: string]: number };
		language?: string;
	}

	class Sentiment {
		analyze(phrase: string, options?: SentimentOptions): SentimentResult;
	}

	export default Sentiment;
}

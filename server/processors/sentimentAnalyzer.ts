/**
 * Simple, fast rule-based sentiment analysis.
 * No ML model needed - perfect for 100-user scale crawler.
 */

interface SentimentResult {
	label: "positive" | "negative" | "neutral";
	confidence: number;
}

// Comprehensive word lists for better accuracy
const positiveWords = new Set([
	// General positive
	"good",
	"great",
	"excellent",
	"amazing",
	"wonderful",
	"fantastic",
	"awesome",
	"love",
	"best",
	"perfect",
	"brilliant",
	"outstanding",
	"superb",
	"magnificent",
	"exceptional",
	"remarkable",
	"extraordinary",
	"happy",
	"joy",
	"delight",
	"pleased",
	"satisfied",
	"excited",
	"thrilled",
	"ecstatic",
	"glad",
	"cheerful",
	"beautiful",
	"gorgeous",
	"stunning",
	"impressive",
	"incredible",
	"fabulous",
	"terrific",
	"marvelous",
	"wonderful",
	"excellent",
	"perfect",
	"outstanding",
	"superb",
	"magnificent",
	"brilliant",
	"amazing",
	"awesome",
	"love",
	"adore",
	"enjoy",
	"like",
	"appreciate",
	"recommend",
	"favorite",
	"best",
	"top",
	"premium",
	"quality",
	"professional",
	"reliable",
	"trust",
	// Intensifiers
	"very",
	"really",
	"truly",
	"absolutely",
	"definitely",
	"certainly",
	"highly",
]);

const negativeWords = new Set([
	// General negative
	"bad",
	"terrible",
	"awful",
	"worst",
	"hate",
	"horrible",
	"disappointing",
	"poor",
	"wrong",
	"fail",
	"disaster",
	"atrocious",
	"appalling",
	"dreadful",
	"unacceptable",
	"inadequate",
	"unsatisfactory",
	"sad",
	"angry",
	"frustrated",
	"annoying",
	"useless",
	"broken",
	"stupid",
	"ridiculous",
	"pathetic",
	"lame",
	"boring",
	"dull",
	"mediocre",
	"inferior",
	"flawed",
	"defective",
	"damaged",
	"waste",
	"trash",
	"garbage",
	"joke",
	"scam",
	"fraud",
	"fake",
	"misleading",
	"disgusting",
	"gross",
	"nasty",
	"ugly",
	"hideous",
	"repulsive",
	"offensive",
	"hated",
	"disliked",
	"avoid",
	"never",
	"sucks",
	"suck",
	"crap",
	"damn",
	"stupid",
	"dumb",
	"idiot",
	"ridiculous",
	// Weak words
	"boring",
	"dull",
	"plain",
	"basic",
	"meh",
	"okay",
	"fine",
]);

const negationWords = new Set([
	"not",
	"no",
	"never",
	"neither",
	"nor",
	"none",
	"nothing",
	"nobody",
	"nowhere",
	"hardly",
	"barely",
	"scarcely",
	"seldom",
	"isn't",
	"aren't",
	"wasn't",
	"weren't",
	"haven't",
	"hasn't",
	"hadn't",
	"don't",
	"doesn't",
	"didn't",
	"won't",
	"wouldn't",
	"can't",
	"cannot",
	"couldn't",
	"shouldn't",
]);

/**
 * Analyzes text sentiment using fast rule-based approach.
 * No ML model needed - processes text instantly.
 */
export async function analyzeSentiment(text: string): Promise<SentimentResult> {
	// Skip very short texts
	if (!text || text.length < 10) {
		return { label: "neutral", confidence: 0.5 };
	}

	const words = text.toLowerCase().split(/\s+/);
	let positiveCount = 0;
	let negativeCount = 0;
	let negationActive = false;
	let negationStartIndex = -1;

	for (let i = 0; i < words.length; i++) {
		const word = words[i].replace(/[^a-z]/g, ""); // Clean punctuation
		if (!word) continue;

		// Check for negation
		if (negationWords.has(word)) {
			negationActive = true;
			negationStartIndex = i;
			continue;
		}

		// End negation scope after 3 words from the negation word
		if (negationActive && i - negationStartIndex > 3) {
			negationActive = false;
		}

		// Count sentiment words (with negation flip)
		if (positiveWords.has(word)) {
			if (negationActive) {
				negativeCount++;
			} else {
				positiveCount++;
			}
		} else if (negativeWords.has(word)) {
			if (negationActive) {
				positiveCount++;
			} else {
				negativeCount++;
			}
		}
	}

	// Calculate total sentiment words found
	const totalSentimentWords = positiveCount + negativeCount;

	// If no sentiment words found, neutral
	if (totalSentimentWords === 0) {
		return { label: "neutral", confidence: 0.5 };
	}

	// Determine sentiment with confidence based on ratio
	if (positiveCount > negativeCount) {
		const ratio = positiveCount / (positiveCount + negativeCount);
		return {
			label: "positive",
			confidence: 0.5 + ratio * 0.5, // 0.5-1.0 based on ratio
		};
	} else if (negativeCount > positiveCount) {
		const ratio = negativeCount / (positiveCount + negativeCount);
		return {
			label: "negative",
			confidence: 0.5 + ratio * 0.5,
		};
	}

	return { label: "neutral", confidence: 0.5 };
}

/**
 * Clears any cached sentiment data (for API compatibility).
 */
export function clearSentimentPipeline(): void {
	// No-op for rule-based analyzer
}

/**
 * Always returns true for rule-based analyzer (for API compatibility).
 */
export function isSentimentModelLoaded(): boolean {
	return true; // Rule-based is always "loaded"
}

import { franc } from "franc";

const LANGUAGE_CODES: Record<string, string> = {
	eng: "en",
	spa: "es",
	fra: "fr",
	deu: "de",
	ita: "it",
	por: "pt",
	rus: "ru",
	jpn: "ja",
	cmn: "zh",
	kor: "ko",
	ara: "ar",
	nld: "nl",
	pol: "pl",
	tur: "tr",
	vie: "vi",
	tha: "th",
	ind: "id",
	ces: "cs",
	ell: "el",
	heb: "he",
	swe: "sv",
	hun: "hu",
	fin: "fi",
	dan: "da",
	nor: "no",
};

export function analyzeContent(text: string) {
	const cleanText = text.trim();
	const wordCount = cleanText ? cleanText.split(/\s+/).length : 0;
	const detected = franc(cleanText, { minLength: 10 });
	return {
		wordCount,
		readingTime: Math.ceil(wordCount / 200),
		language: LANGUAGE_CODES[detected] ?? "unknown",
	};
}

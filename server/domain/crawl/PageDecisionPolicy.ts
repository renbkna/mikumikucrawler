import { SOFT_404_CONSTANTS } from "../../constants.js";

export interface RobotsDirectives {
	noindex: boolean;
	nofollow: boolean;
}

export function parseRobotsDirectives(
	value: string | null | undefined,
): RobotsDirectives {
	const result = { noindex: false, nofollow: false };
	if (!value) return result;

	const normalized = value
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean)
		.join(",");

	result.noindex = /\bnoindex\b|\bnone\b/.test(normalized);
	result.nofollow = /\bnofollow\b|\bnone\b/.test(normalized);
	return result;
}

export function mergeRobotsDirectives(
	metaRobots: string | undefined,
	header: string | null,
): RobotsDirectives {
	const fromMeta = parseRobotsDirectives(metaRobots);
	const fromHeader = parseRobotsDirectives(header);
	return {
		noindex: fromMeta.noindex || fromHeader.noindex,
		nofollow: fromMeta.nofollow || fromHeader.nofollow,
	};
}

export function isSoft404(
	title: string,
	mainContent: string,
	contentLength: number,
): boolean {
	const trimmedMainContent = mainContent.trim();
	if (
		contentLength > 0 &&
		contentLength < SOFT_404_CONSTANTS.TINY_CONTENT_BYTES &&
		trimmedMainContent.length === 0
	) {
		return true;
	}

	const titleLower = title.toLowerCase();
	if (
		SOFT_404_CONSTANTS.KEYWORDS.some((keyword) => titleLower.includes(keyword))
	) {
		return true;
	}

	if (contentLength < SOFT_404_CONSTANTS.SHORT_CONTENT_BYTES) {
		const contentLower = trimmedMainContent.toLowerCase().slice(0, 1000);
		if (
			SOFT_404_CONSTANTS.KEYWORDS.some((keyword) =>
				contentLower.includes(keyword),
			)
		) {
			return true;
		}
	}

	return false;
}

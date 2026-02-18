/**
 * Shared utility helpers.
 *
 * Robots.txt parsing logic has been moved to ./robotsParser.ts.
 * Re-exported here so existing consumers don't need to change their imports.
 */

// Re-export so callers importing getRobotsRules from helpers.js continue to work.
export { getRobotsRules } from "./robotsParser.js";

/**
 * Extracts a message from an unknown error value.
 * Use this instead of inline `err instanceof Error ? err.message : String(error)` checks.
 */
export function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return String(error);
}

interface NormalizeResult {
	url?: string;
	error?: string;
}

/**
 * Normalizes a URL by enforcing protocol, removing hash fragments, and stripping trailing slashes.
 */
export function normalizeUrl(url: string): NormalizeResult {
	if (!url || typeof url !== "string") {
		return { error: "URL is required" };
	}

	let normalizedUrl = url.trim();

	if (!/^https?:\/\//i.test(normalizedUrl)) {
		normalizedUrl = `http://${normalizedUrl}`;
	}

	try {
		const parsed = new URL(normalizedUrl);

		if (!["http:", "https:"].includes(parsed.protocol)) {
			return { error: "Only HTTP and HTTPS URLs are supported" };
		}

		parsed.hash = "";

		let result = parsed.toString();

		if (result.endsWith("/") && parsed.pathname !== "/") {
			result = result.slice(0, -1);
		}

		return { url: result };
	} catch {
		return { error: "Invalid URL format" };
	}
}

type CheerioLike = (selector: string) => {
	text(): string;
	each(callback: (index: number, element: unknown) => void): void;
	attr(name: string): string | undefined;
};

interface MetadataResult {
	title: string;
	description: string;
}

/** Extracts title and description metadata from a Cheerio-loaded HTML document. */
export function extractMetadata($: CheerioLike): MetadataResult {
	const title = $("title").text().trim() || "";

	let description = "";
	$('meta[name="description"]').each((_: number, el: unknown) => {
		description = $(el as string).attr("content") || "";
	});
	if (!description) {
		$('meta[property="og:description"]').each((_: number, el: unknown) => {
			description = $(el as string).attr("content") || "";
		});
	}

	return { title, description };
}

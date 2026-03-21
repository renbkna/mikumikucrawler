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

const STRIP_PARAMS = new Set([
	// UTM campaign parameters
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_term",
	"utm_content",
	"utm_id",
	// Ad-network click IDs
	"fbclid",
	"gclid",
	"gbraid",
	"wbraid",
	"msclkid",
	"ttclid",
	"twclid",
	"li_fat_id",
	// Google Analytics client/session IDs (sometimes leaked into URLs)
	"_ga",
	"_gid",
	// Common server-side session ID names
	"sessionid",
	"phpsessid",
	"jsessionid",
	"aspsessionid",
	"sid",
]);

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

		parsed.hostname = parsed.hostname.toLowerCase();

		if (
			(parsed.protocol === "http:" && parsed.port === "80") ||
			(parsed.protocol === "https:" && parsed.port === "443")
		) {
			parsed.port = "";
		}

		parsed.hash = "";

		if (parsed.search) {
			const params = new URLSearchParams(parsed.search);
			for (const key of params.keys()) {
				if (STRIP_PARAMS.has(key.toLowerCase())) {
					params.delete(key);
				}
			}
			const sorted = new URLSearchParams([...params.entries()].sort());
			parsed.search = sorted.toString() ? `?${sorted.toString()}` : "";
		}

		let result = parsed.toString();
		if (result.endsWith("/") && parsed.pathname !== "/") {
			result = result.slice(0, -1);
		}

		return { url: result };
	} catch {
		return { error: "Invalid URL format" };
	}
}

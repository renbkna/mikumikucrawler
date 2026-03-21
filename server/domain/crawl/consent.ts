/**
 * Consent-wall contract:
 * - detect common consent/interstitial screens using body text
 * - recognize action labels across localized variants
 * - for consent-sensitive domains such as YouTube, do not degrade to static crawl
 *   when the wall is detected but not bypassed
 */

const CONSENT_WALL_MARKERS = [
	"before you continue",
	"agree to the use of cookies",
	"accept all cookies",
	"cookie preferences",
	"we value your privacy",
	"bevor sie fortfahren",
	"bevor du fortfährst",
	"cookies akzeptieren",
	"alle akzeptieren",
	"datenschutzeinstellungen",
	"zustimmen und fortfahren",
] as const;

const CONSENT_ACTION_MARKERS = [
	"accept all",
	"accept cookies",
	"i agree",
	"agree all",
	"accept",
	"agree",
	"allow",
	"allow all",
	"got it",
	"continue",
	"agree to the use of cookies",
	"alle akzeptieren",
	"alle annehmen",
	"akzeptieren",
	"zustimmen",
	"ich stimme zu",
	"zustimmen und fortfahren",
	"einverstanden",
] as const;

export const CONSENT_BUTTON_SELECTORS = [
	'button[aria-label*="Accept"]',
	'button[aria-label*="agree"]',
	'button[aria-label*="Akzept"]',
	'button[aria-label*="Zustimm"]',
	"ytd-button-renderer#accept-button button",
	"button.yt-spec-button-shape-next--call-to-action",
	'#dialog button[aria-label*="Accept all"]',
] as const;

function normalizeText(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isConsentWallText(text: string): boolean {
	const normalized = normalizeText(text);
	return CONSENT_WALL_MARKERS.some((marker) => normalized.includes(marker));
}

export function isConsentActionText(
	...values: Array<string | null | undefined>
): boolean {
	return values.some((value) => {
		if (!value) return false;
		const normalized = normalizeText(value);
		return CONSENT_ACTION_MARKERS.some((marker) => normalized.includes(marker));
	});
}

export function requiresStrictConsentBypass(url: string): boolean {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.replace(/^www\./, "");
		return hostname === "youtube.com" || hostname.endsWith(".youtube.com");
	} catch {
		return false;
	}
}

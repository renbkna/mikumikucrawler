/**
 * Consent-wall contract:
 * - detect common consent/interstitial screens using body text
 * - recognize action labels across localized variants
 * - for STRICT_CONSENT_DOMAINS, do not degrade to static crawl when the wall is
 *   detected but not bypassed
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

export const CONSENT_ACTION_MARKERS = [
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

export const CONSENT_NEGATIVE_ACTION_MARKERS = [
	"do not accept",
	"don't accept",
	"not accept",
	"do not agree",
	"don't agree",
	"reject",
	"decline",
	"necessary only",
	"essential only",
	"manage preferences",
	"nicht akzeptieren",
	"nicht zustimmen",
	"ablehnen",
	"nur notwendige",
	"einstellungen verwalten",
] as const;

/** Exact controls for known consent dialogs, tried before text-based matching. */
export const CONSENT_BUTTON_SELECTORS = [
	"ytd-button-renderer#accept-button button",
	'#dialog button[aria-label="Accept all"]',
] as const;

function normalizeText(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isConsentWallText(text: string): boolean {
	const normalized = normalizeText(text);
	return CONSENT_WALL_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Sites whose consent wall hides the real document: an unbypassed wall there is a
 * blocked fetch, not content, and must not degrade to a static crawl of the wall.
 */
export const STRICT_CONSENT_DOMAINS = ["youtube.com"] as const;

export function requiresStrictConsentBypass(url: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return false;
	}
	return STRICT_CONSENT_DOMAINS.some(
		(domain) => hostname === domain || hostname.endsWith(`.${domain}`),
	);
}

export function isUnresolvedStrictConsentWall(
	result: { detected: boolean; bypassed: boolean },
	finalDocumentUrl: string,
): boolean {
	return result.detected && !result.bypassed && requiresStrictConsentBypass(finalDocumentUrl);
}

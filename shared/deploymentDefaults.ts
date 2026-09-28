export const DEFAULT_BACKEND_PORT = 3000;

/**
 * Parses an integer setting: empty or absent means `defaultValue`; anything else must be
 * a decimal integer within `bounds`, or startup fails with the setting's name.
 */
export function parseIntegerSetting(
	name: string,
	raw: string | undefined,
	defaultValue: number,
	bounds: { min: number; max: number },
): number {
	if (raw === undefined || raw === "") return defaultValue;
	const normalized = raw.trim();
	const value = /^-?\d+$/.test(normalized) ? Number.parseInt(normalized, 10) : Number.NaN;
	if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
		throw new Error(
			`Invalid environment variable ${name}="${raw}" — expected an integer between ${bounds.min} and ${bounds.max} (default: ${defaultValue}).`,
		);
	}
	return value;
}

export function resolveBackendPort(rawPort: string | undefined): number {
	return parseIntegerSetting("PORT", rawPort, DEFAULT_BACKEND_PORT, { min: 1, max: 65535 });
}

export function developmentBackendUrl(port: number): string {
	return `http://localhost:${port}`;
}

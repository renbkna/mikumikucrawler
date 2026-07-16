export interface CorsOriginPolicy {
	frontendUrl: string;
	isDevelopment: boolean;
}

const DEVELOPMENT_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isCorsOriginAllowed(origin: string | null, policy: CorsOriginPolicy): boolean {
	if (origin === null) return false;
	if (origin === policy.frontendUrl) return true;
	if (!policy.isDevelopment) return false;

	try {
		const url = new URL(origin);
		return (
			url.origin === origin &&
			(url.protocol === "http:" || url.protocol === "https:") &&
			DEVELOPMENT_LOOPBACK_HOSTS.has(url.hostname)
		);
	} catch {
		return false;
	}
}

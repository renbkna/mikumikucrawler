export interface CorsOriginPolicy {
	frontendOrigin: string;
	isDevelopment: boolean;
}

const DEVELOPMENT_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isCorsOriginAllowed(origin: string | null, policy: CorsOriginPolicy): boolean {
	if (origin === null) return false;

	try {
		const url = new URL(origin);
		if (url.origin !== origin || (url.protocol !== "http:" && url.protocol !== "https:")) {
			return false;
		}
		if (url.origin === policy.frontendOrigin) return true;
		if (!policy.isDevelopment) return false;
		return DEVELOPMENT_LOOPBACK_HOSTS.has(url.hostname);
	} catch {
		return false;
	}
}

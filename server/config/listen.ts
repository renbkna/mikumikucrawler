export const MAX_API_REQUEST_BODY_BYTES = 16 * 1024;

export function createServerListenOptions(port: number, allowLocalhostTargets = false) {
	return {
		hostname: allowLocalhostTargets ? "127.0.0.1" : "0.0.0.0",
		maxRequestBodySize: MAX_API_REQUEST_BODY_BYTES,
		port,
		reusePort: false,
	} as const;
}

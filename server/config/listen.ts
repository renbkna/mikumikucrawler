export function createServerListenOptions(port: number) {
	return {
		port,
		reusePort: false,
	} as const;
}

export const DEFAULT_BACKEND_PORT = 3000;

export function resolveBackendPort(rawPort: string | undefined): number {
	if (rawPort === undefined || rawPort === "") return DEFAULT_BACKEND_PORT;

	const normalized = rawPort.trim();
	if (!/^-?\d+$/.test(normalized)) {
		throw new Error(
			`Invalid environment variable PORT="${rawPort}" — expected an integer (default: ${DEFAULT_BACKEND_PORT}).`,
		);
	}

	const port = Number.parseInt(normalized, 10);
	if (port < 1 || port > 65535) {
		throw new Error(`Invalid PORT=${port} — must be between 1 and 65535.`);
	}

	return port;
}

export function developmentBackendUrl(port: number): string {
	return `http://localhost:${port}`;
}

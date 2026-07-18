import { developmentBackendUrl, resolveBackendPort } from "../../shared/deploymentDefaults.js";

export interface BackendUrlEnv {
	VITE_BACKEND_URL?: string;
}

export type BackendTransportPolicy =
	| { type: "same-origin"; connectSource: ""; proxyTarget?: undefined }
	| { type: "same-origin-proxy"; connectSource: ""; proxyTarget: string }
	| { type: "cross-origin"; connectSource: string; proxyTarget?: undefined };

interface ConfiguredBackendEndpoint {
	baseUrl: string;
	connectSource: string;
}

function resolveConfiguredBackendEndpoint(configuredBackendUrl: string): ConfiguredBackendEndpoint {
	let parsed: URL;
	try {
		parsed = new URL(configuredBackendUrl);
	} catch (error) {
		throw new Error("VITE_BACKEND_URL must be an absolute HTTP(S) URL", { cause: error });
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("VITE_BACKEND_URL must use HTTP or HTTPS");
	}
	if (parsed.username || parsed.password) {
		throw new Error("VITE_BACKEND_URL must not include credentials");
	}
	if (parsed.search || parsed.hash) {
		throw new Error("VITE_BACKEND_URL must not include a query or fragment");
	}

	const path = parsed.pathname.replace(/\/+$/, "");
	return {
		baseUrl: `${parsed.origin}${path}`,
		connectSource: parsed.origin,
	};
}

export function resolveBackendUrl(
	env: BackendUrlEnv,
	origin = globalThis.window?.location.origin,
): string {
	if (env.VITE_BACKEND_URL) {
		return resolveConfiguredBackendEndpoint(env.VITE_BACKEND_URL).baseUrl;
	}

	return origin ?? "http://localhost";
}

export function buildBackendApiUrl(baseUrl: string, path: string): string {
	return `${baseUrl}${path}`;
}

export function resolveBackendTransportPolicy(
	configuredBackendUrl: string | undefined,
	localProxy?: { rawPort: string | undefined },
): BackendTransportPolicy {
	if (configuredBackendUrl) {
		const endpoint = resolveConfiguredBackendEndpoint(configuredBackendUrl);
		return {
			type: "cross-origin",
			connectSource: endpoint.connectSource,
		};
	}

	if (localProxy) {
		return {
			type: "same-origin-proxy",
			connectSource: "",
			proxyTarget: developmentBackendUrl(resolveBackendPort(localProxy.rawPort)),
		};
	}

	return { type: "same-origin", connectSource: "" };
}

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { SERVER_OWNED_PATH_PREFIXES } from "./shared/contracts/api.js";
import { resolveBackendTransportPolicy } from "./src/api/backendUrl.js";

const BACKEND_CONNECT_SOURCE_MARKER = "__VITE_BACKEND_CONNECT_SOURCE__";
const SCRIPT_SOURCE_MARKER = "__VITE_SCRIPT_SOURCE__";

export default defineConfig(({ command, mode }) => {
	const environment = loadEnv(mode, process.cwd(), "");
	const configuredBackendUrl = process.env.VITE_BACKEND_URL ?? environment.VITE_BACKEND_URL;
	const backendPolicy = resolveBackendTransportPolicy(
		configuredBackendUrl,
		command === "serve" ? { rawPort: process.env.PORT ?? environment.PORT } : undefined,
	);
	const developmentScriptSource = command === "serve" ? "'unsafe-inline'" : "";

	return {
		plugins: [
			{
				name: "backend-csp-source",
				transformIndexHtml(html) {
					return html
						.replaceAll(BACKEND_CONNECT_SOURCE_MARKER, backendPolicy.connectSource)
						.replaceAll(SCRIPT_SOURCE_MARKER, developmentScriptSource);
				},
			},
			react(),
			tailwindcss(),
		],
		build: {
			target: "es2022",
		},
		...(backendPolicy.type === "same-origin-proxy"
			? {
					server: {
						proxy: Object.fromEntries(
							// Keys starting with ^ are RegExps: match whole path segments, like isServerOwnedPath.
							SERVER_OWNED_PATH_PREFIXES.map((prefix) => [
								`^${prefix}(?:[/?]|$)`,
								{ target: backendPolicy.proxyTarget, changeOrigin: true },
							]),
						),
					},
				}
			: {}),
	};
});

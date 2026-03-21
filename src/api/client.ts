import { treaty } from "@elysiajs/eden";
import type { App } from "../../server/app";

const backendUrl = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";

/** Type-safe Eden Treaty client for the Miku Crawler API */
export const api = treaty<App>(backendUrl);

export function getBackendUrl(): string {
	return backendUrl.replace(/\/$/, "");
}

import { Elysia } from "elysia";
import { LRUCache } from "lru-cache";
import type { ApiError } from "../contracts/errors.js";

interface AdmissionWindow {
	count: number;
	resetAtMs: number;
}

export interface RateLimitOptions {
	/** Requests admitted per client in one window; every request counts, whatever its outcome. */
	max: number;
	windowMs: number;
	/** Bound on tracked clients; the least recently seen client's window is forgotten first. */
	maxClients: number;
	clientKey: (request: Request) => string;
	isExempt: (request: Request) => boolean;
	now?: () => number;
}

const RATE_LIMITED: ApiError = { error: "Too many requests", code: "RATE_LIMITED" };

/**
 * Fixed-window admission per client, decided once per request before routing and body
 * parsing, so unknown routes and malformed or invalid requests spend the same budget.
 */
export function rateLimitPlugin({
	max,
	windowMs,
	maxClients,
	clientKey,
	isExempt,
	now = Date.now,
}: RateLimitOptions) {
	const windows = new LRUCache<string, AdmissionWindow>({ max: maxClients });

	return new Elysia({ name: "rate-limit" }).request(({ request, set, status }) => {
		if (isExempt(request)) return;
		const key = clientKey(request);
		const nowMs = now();
		let window = windows.get(key);
		if (!window || window.resetAtMs <= nowMs) {
			window = { count: 0, resetAtMs: nowMs + windowMs };
			windows.set(key, window);
		}
		window.count += 1;
		if (window.count <= max) return;

		set.headers["retry-after"] = String(Math.ceil((window.resetAtMs - nowMs) / 1000));
		return status(429, RATE_LIMITED);
	});
}

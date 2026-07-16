import { describe, expect, test } from "bun:test";
import { isCorsOriginAllowed } from "../cors.js";

describe("CORS origin policy", () => {
	test("development admits browser origins on exact loopback hosts without fixing the Vite port", () => {
		const policy = {
			frontendUrl: "https://configured.example",
			isDevelopment: true,
		};

		for (const origin of [
			"http://localhost:5173",
			"http://localhost:5176",
			"https://localhost:4173",
			"http://127.0.0.1:5176",
			"http://[::1]:5176",
		]) {
			expect(isCorsOriginAllowed(origin, policy)).toBe(true);
		}

		for (const origin of [
			"http://localhost.example:5176",
			"http://example.com:5176",
			"file://localhost/app",
			"null",
			"not an origin",
		]) {
			expect(isCorsOriginAllowed(origin, policy)).toBe(false);
		}
	});

	test("configured origin is admitted in every environment without widening production", () => {
		const policy = {
			frontendUrl: "https://crawler.example",
			isDevelopment: false,
		};

		expect(isCorsOriginAllowed("https://crawler.example", policy)).toBe(true);
		expect(isCorsOriginAllowed("http://localhost:5176", policy)).toBe(false);
		expect(isCorsOriginAllowed("https://other.example", policy)).toBe(false);
		expect(isCorsOriginAllowed(null, policy)).toBe(false);
	});
});

import pino from "pino";
import type { HttpClient } from "../outbound/HttpClient.js";

export const silentLogger = pino({ level: "silent" });

export function htmlDocumentResponse(html: string): Response {
	return new Response(html, {
		status: 200,
		headers: { "content-type": "text/html" },
	});
}

export function htmlResponse(content = "Hello world"): Response {
	return htmlDocumentResponse(`<html><body><main>${content}</main></body></html>`);
}

export const successfulHtmlHttpClient: HttpClient = {
	fetch: async () => htmlResponse(),
};

export async function waitFor<T>(read: () => T, predicate: (value: T) => boolean): Promise<T> {
	const timeoutAt = Date.now() + 5000;
	while (Date.now() < timeoutAt) {
		const value = read();
		if (predicate(value)) return value;
		await Bun.sleep(25);
	}

	throw new Error("Timed out waiting for condition");
}

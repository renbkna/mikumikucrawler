import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { Elysia, StatusMap } from "elysia";

const MIN_COMPRESS_BYTES = 1024;

interface ResponseSet {
	status?: number | string;
	headers?: unknown;
}

function isCompressibleContentType(contentType: string): boolean {
	const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	return (
		normalized.startsWith("text/") ||
		normalized === "application/json" ||
		normalized.endsWith("+json") ||
		normalized === "application/javascript" ||
		normalized === "application/xml" ||
		normalized.endsWith("+xml") ||
		normalized === "application/x-www-form-urlencoded"
	);
}

function isNeverCompressedContentType(contentType: string): boolean {
	const normalized = contentType.toLowerCase();
	return (
		normalized.includes("text/event-stream") ||
		normalized.includes("image/") ||
		normalized.includes("video/") ||
		normalized.includes("audio/") ||
		normalized.includes("application/gzip") ||
		normalized.includes("application/x-gzip") ||
		normalized.includes("application/zip") ||
		normalized.includes("application/x-7z-compressed") ||
		normalized.includes("application/x-rar-compressed") ||
		normalized.includes("application/zstd") ||
		normalized.includes("application/octet-stream")
	);
}

function headersFromSet(set: ResponseSet): Headers {
	const headers = new Headers();
	const source = set.headers;

	if (!source) {
		return headers;
	}

	if (source instanceof Headers) {
		for (const [key, value] of source) {
			headers.set(key, value);
		}
		return headers;
	}

	if (Array.isArray(source)) {
		for (const [key, value] of source) {
			if (value !== undefined) {
				headers.set(String(key), String(value));
			}
		}
		return headers;
	}

	if (typeof source === "object") {
		for (const [key, value] of Object.entries(source)) {
			if (value === undefined) {
				continue;
			}

			if (Array.isArray(value)) {
				for (const item of value) {
					headers.append(key, String(item));
				}
			} else {
				headers.set(key, String(value));
			}
		}
	}

	return headers;
}

function responseInitFromSet(set: ResponseSet): ResponseInit {
	return {
		status: normalizeStatus(set.status),
		headers: headersFromSet(set),
	};
}

function normalizeStatus(status: ResponseSet["status"]): number | undefined {
	if (typeof status === "number") {
		return status;
	}

	if (typeof status !== "string") {
		return undefined;
	}

	const normalized = status.trim();
	if (/^\d+$/.test(normalized)) {
		return Number.parseInt(normalized, 10);
	}

	if (normalized in StatusMap) {
		return StatusMap[normalized as keyof typeof StatusMap];
	}

	return undefined;
}

function toResponse(response: unknown, set: ResponseSet): Response | null {
	if (response instanceof Response) {
		return response;
	}

	if (response instanceof Blob) {
		const init = responseInitFromSet(set);
		const headers = new Headers(init.headers);
		if (response.type && !headers.has("content-type")) {
			headers.set("content-type", response.type);
		}

		return new Response(response, {
			...init,
			headers,
		});
	}

	if (
		response !== null &&
		typeof response === "object" &&
		!(response instanceof FormData) &&
		!(response instanceof Error) &&
		!("next" in response) &&
		!("then" in response)
	) {
		return Response.json(response, responseInitFromSet(set));
	}

	if (
		typeof response === "string" ||
		typeof response === "number" ||
		typeof response === "boolean"
	) {
		return new Response(String(response), responseInitFromSet(set));
	}

	return null;
}

function appendVary(headers: Headers, value: string): void {
	const existing = headers.get("vary");
	const existingValues = new Set(
		existing
			?.split(",")
			.map((entry) => entry.trim().toLowerCase())
			.filter(Boolean) ?? [],
	);

	if (existingValues.has(value.toLowerCase())) {
		return;
	}

	headers.set("vary", existing ? `${existing}, ${value}` : value);
}

function parseAcceptEncoding(header: string): Map<string, number> {
	const accepted = new Map<string, number>();
	for (const rawPart of header.split(",")) {
		const [rawToken, ...params] = rawPart.split(";");
		const token = rawToken?.trim().toLowerCase();
		if (!token) {
			continue;
		}

		let quality = 1;
		for (const param of params) {
			const [rawKey, rawValue] = param.split("=");
			if (rawKey?.trim().toLowerCase() !== "q") {
				continue;
			}
			const parsed = Number.parseFloat(rawValue?.trim() ?? "");
			quality = Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 1)) : 0;
		}

		accepted.set(token, quality);
	}
	return accepted;
}

function acceptedQuality(
	accepted: Map<string, number>,
	encoding: "br" | "gzip",
): number {
	return accepted.get(encoding) ?? accepted.get("*") ?? 0;
}

function chooseEncoding(acceptEncoding: string): "br" | "gzip" | null {
	const accepted = parseAcceptEncoding(acceptEncoding);
	const brQuality = acceptedQuality(accepted, "br");
	const gzipQuality = acceptedQuality(accepted, "gzip");
	if (brQuality <= 0 && gzipQuality <= 0) {
		return null;
	}

	return brQuality >= gzipQuality ? "br" : "gzip";
}

async function compressResponse(
	request: Request,
	response: Response,
): Promise<Response | undefined> {
	if (response.headers.get("content-encoding")) return undefined;
	if (request.headers.has("range")) return undefined;
	if ([204, 304].includes(response.status)) return undefined;

	const acceptEncoding = request.headers.get("accept-encoding") || "";
	const contentType = response.headers.get("content-type") || "";

	// Skip compression for streaming, already compressed, or binary formats.
	if (
		isNeverCompressedContentType(contentType) ||
		!isCompressibleContentType(contentType)
	) {
		return undefined;
	}

	const encoding = chooseEncoding(acceptEncoding);
	if (!encoding) {
		return undefined;
	}

	let compressed: Uint8Array;

	// NOTE: arrayBuffer() consumes the body stream. Every return after this point
	// must return a reconstructed Response.
	const body = await response.arrayBuffer();

	if (body.byteLength < MIN_COMPRESS_BYTES) {
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}

	if (encoding === "br") {
		// Avoid Buffer.from() copy: brotliCompressSync accepts Uint8Array directly.
		compressed = brotliCompressSync(new Uint8Array(body), {
			params: {
				[zlibConstants.BROTLI_PARAM_QUALITY]: 4,
			},
		});
	} else {
		compressed = Bun.gzipSync(body, { level: 6 });
	}

	if (compressed.byteLength >= body.byteLength) {
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}

	const mergedHeaders = new Headers(response.headers);
	mergedHeaders.set("content-encoding", encoding);
	mergedHeaders.set("content-length", compressed.byteLength.toString());
	appendVary(mergedHeaders, "accept-encoding");

	const compressedBody = compressed.buffer.slice(
		compressed.byteOffset,
		compressed.byteOffset + compressed.byteLength,
	) as ArrayBuffer;

	return new Response(compressedBody, {
		status: response.status,
		statusText: response.statusText,
		headers: mergedHeaders,
	});
}

/**
 * Compression middleware using Bun's native gzip and Node's zlib for Brotli.
 * Automatically compresses responses based on Accept-Encoding header.
 */
export const compression = () => {
	return new Elysia({ name: "compression" }).mapResponse(
		{ as: "global" },
		async ({ request, response, set }) => {
			const normalized = toResponse(response, set);
			if (!normalized) return undefined;

			return compressResponse(request, normalized);
		},
	);
};

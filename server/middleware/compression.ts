import { Elysia } from "elysia";

/**
 * Compression middleware using Bun's native APIs.
 * Automatically compresses responses based on Accept-Encoding header.
 */
export const compression = () => {
	return new Elysia({ name: "compression" }).onAfterHandle(
		{ as: "global" },
		async ({ request, response, set }) => {
			// Skip if already compressed or not compressible
			if (!(response instanceof Response)) return;
			if (response.headers.get("content-encoding")) return;

			const acceptEncoding = request.headers.get("accept-encoding") || "";
			const contentType = response.headers.get("content-type") || "";

			// Skip compression for already compressed formats
			if (
				contentType.includes("image/") ||
				contentType.includes("video/") ||
				contentType.includes("audio/") ||
				contentType.includes("application/gzip") ||
				contentType.includes("application/zip")
			) {
				return;
			}

			const body = await response.arrayBuffer();

			// Only compress if body is > 1KB (compression overhead not worth it for small responses)
			if (body.byteLength < 1024) return;

			let compressed: Uint8Array;
			let encoding: string;

			// Prefer Brotli, fallback to gzip
			if (acceptEncoding.includes("br")) {
				compressed = Bun.gzipSync(body, { level: 4 }); // level 4 is good balance
				encoding = "br";
			} else if (acceptEncoding.includes("gzip")) {
				compressed = Bun.gzipSync(body, { level: 6 }); // default gzip level
				encoding = "gzip";
			} else {
				return; // No compression support
			}

			// Only use compressed if it's actually smaller
			if (compressed.byteLength >= body.byteLength) return;

			set.headers["content-encoding"] = encoding;
			set.headers["content-length"] = compressed.byteLength.toString();
			set.headers.vary = "accept-encoding";

			return new Response(compressed.buffer as ArrayBuffer, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		},
	);
};

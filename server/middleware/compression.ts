import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { Elysia } from "elysia";

/**
 * Compression middleware using Bun's native gzip and Node's zlib for Brotli.
 * Automatically compresses responses based on Accept-Encoding header.
 */
export const compression = () => {
	return new Elysia({ name: "compression" }).onAfterHandle(
		{ as: "global" },
		async ({ request, response }) => {
			// Skip if already compressed or not compressible
			if (!(response instanceof Response)) return;
			if (response.headers.get("content-encoding")) return;

			const acceptEncoding = request.headers.get("accept-encoding") || "";
			const contentType = response.headers.get("content-type") || "";

			// Skip compression for streaming, already compressed, or binary formats
			if (
				contentType.includes("text/event-stream") ||
				contentType.includes("image/") ||
				contentType.includes("video/") ||
				contentType.includes("audio/") ||
				contentType.includes("application/gzip") ||
				contentType.includes("application/zip")
			) {
				return;
			}

			// NOTE: arrayBuffer() consumes the body stream. Any early return after this
			// point must reconstruct a new Response from `body` — returning `undefined`
			// (i.e. "use the original") would produce an empty body because the stream
			// has already been drained.
			const body = await response.arrayBuffer();

			// Not worth compressing — pass through a reconstructed response so the
			// consumed body stream is still delivered to the client.
			if (body.byteLength < 1024) {
				return new Response(body, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			}

			let compressed: Uint8Array;
			let encoding: string;

			if (acceptEncoding.includes("br")) {
				// Avoid Buffer.from() copy — brotliCompressSync accepts Uint8Array directly.
				compressed = brotliCompressSync(new Uint8Array(body), {
					params: {
						[zlibConstants.BROTLI_PARAM_QUALITY]: 4,
					},
				});
				encoding = "br";
			} else if (acceptEncoding.includes("gzip")) {
				compressed = Bun.gzipSync(body, { level: 6 });
				encoding = "gzip";
			} else {
				// No supported encoding requested — pass through with reconstructed response.
				return new Response(body, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			}

			// Compression made it larger — serve original body.
			if (compressed.byteLength >= body.byteLength) {
				return new Response(body, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			}

			// Build merged headers: start from original, then apply compression-specific overrides.
			// We cannot use set.headers here because Elysia applies set.headers AFTER onAfterHandle;
			// returning a new Response bypasses that, so we must bake all headers into the Response directly.
			const mergedHeaders = new Headers(response.headers);
			mergedHeaders.set("content-encoding", encoding);
			mergedHeaders.set("content-length", compressed.byteLength.toString());
			// Append to Vary rather than overwrite so existing values (e.g. "Cookie") are preserved
			const existingVary = mergedHeaders.get("vary");
			mergedHeaders.set(
				"vary",
				existingVary ? `${existingVary}, accept-encoding` : "accept-encoding",
			);

			return new Response(compressed.buffer as ArrayBuffer, {
				status: response.status,
				statusText: response.statusText,
				headers: mergedHeaders,
			});
		},
	);
};

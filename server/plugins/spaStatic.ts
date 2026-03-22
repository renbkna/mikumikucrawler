import path from "node:path";
import { Elysia } from "elysia";
import { resolveStaticFilePath } from "../utils/staticFilePath.js";

interface SpaStaticPluginOptions {
	distPath: string;
}

function isCacheableAsset(requestPath: string): boolean {
	return /\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/i.test(
		requestPath,
	);
}

export function spaStaticPlugin({ distPath }: SpaStaticPluginOptions) {
	return new Elysia({ name: "spa-static-plugin" }).get(
		"*",
		async (context: {
			path: string;
			headers: Record<string, string | undefined>;
		}) => {
			const requestPath = context.path;
			const headers = context.headers;
			if (requestPath.startsWith("/api") || requestPath === "/health") {
				return Response.json({ error: "Not Found" }, { status: 404 });
			}

			const filePath = resolveStaticFilePath(distPath, requestPath);
			if (!filePath) {
				return Response.json({ error: "Not Found" }, { status: 404 });
			}

			const file = Bun.file(filePath);
			if (await file.exists()) {
				if (isCacheableAsset(requestPath)) {
					const etag = `W/"${file.size}-${file.lastModified}"`;
					const ifNoneMatch = headers["if-none-match"];
					if (ifNoneMatch === etag) {
						return new Response(null, { status: 304 });
					}

					return new Response(file, {
						headers: {
							"Content-Type": file.type,
							"Cache-Control": "public, max-age=31536000, immutable",
							ETag: etag,
						},
					});
				}

				return file;
			}

			return Bun.file(path.join(distPath, "index.html"));
		},
	);
}

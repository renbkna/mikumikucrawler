import path from "node:path";
import { Elysia } from "elysia";
import { API_PATHS, isApiPath } from "../../shared/contracts/index.js";
import { resolveStaticFilePath } from "../utils/staticFilePath.js";

interface SpaStaticPluginOptions {
	distPath: string;
}

function isImmutableAsset(requestPath: string): boolean {
	return /\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/i.test(
		requestPath,
	);
}

function isAssetRequest(requestPath: string): boolean {
	return /\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|json|webmanifest|mp3|wav|ogg|map|txt|xml)$/i.test(
		requestPath,
	);
}

function isApiRequest(requestPath: string): boolean {
	return isApiPath(requestPath);
}

function ifNoneMatchIncludes(ifNoneMatch: string | undefined, etag: string) {
	if (!ifNoneMatch) {
		return false;
	}

	return ifNoneMatch
		.split(",")
		.map((validator) => validator.trim())
		.some((validator) => validator === "*" || validator === etag);
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
			if (isApiRequest(requestPath) || requestPath === API_PATHS.health) {
				return Response.json({ error: "Not Found" }, { status: 404 });
			}

			const filePath = resolveStaticFilePath(distPath, requestPath);
			if (!filePath) {
				return Response.json({ error: "Not Found" }, { status: 404 });
			}

			const file = Bun.file(filePath);
			if (await file.exists()) {
				if (isImmutableAsset(requestPath)) {
					const etag = `W/"${file.size}-${file.lastModified}"`;
					const cacheControl = "public, max-age=31536000, immutable";
					const ifNoneMatch = headers["if-none-match"];
					if (ifNoneMatchIncludes(ifNoneMatch, etag)) {
						return new Response(null, {
							status: 304,
							headers: {
								"Cache-Control": cacheControl,
								ETag: etag,
							},
						});
					}

					return new Response(file, {
						headers: {
							"Content-Type": file.type,
							"Cache-Control": cacheControl,
							ETag: etag,
						},
					});
				}

				return file;
			}

			if (isAssetRequest(requestPath)) {
				return Response.json({ error: "Not Found" }, { status: 404 });
			}

			return Bun.file(path.join(distPath, "index.html"));
		},
	);
}

import path from "node:path";
import { staticPlugin } from "@elysia/static";
import { Elysia, status } from "elysia";
import { API_PATHS, isApiPath } from "../../shared/contracts/index.js";

interface SpaStaticPluginOptions {
	distPath: string;
}

const SPA_DOCUMENT_CACHE_CONTROL = "no-store";

const ROOT_STATIC_IGNORES = [
	/(?:^|[\\/])assets(?:[\\/]|$)/,
	/(?:^|[\\/])api(?:[\\/]|$)/,
	/(?:^|[\\/])health$/,
	/(?:^|[\\/])openapi(?:[\\/]|$)/,
	/(?:^|[\\/])index\.html$/,
	/(?:^|[\\/])\.DS_Store$/,
	/(?:^|[\\/])\.git(?:[\\/]|$)/,
	/(?:^|[\\/])\.env(?:\.[^\\/]+)?$/,
];

function isSpaDocumentRequest(request: Request, requestPath: string): boolean {
	if (requestPath === "/" || requestPath === "/index.html") return true;
	return request.headers.get("accept")?.toLowerCase().includes("text/html") === true;
}

function decodeRequestPath(requestPath: string): string | null {
	try {
		return decodeURIComponent(requestPath);
	} catch {
		return null;
	}
}

export async function spaStaticPlugin({ distPath }: SpaStaticPluginOptions) {
	const versionedAssets = await staticPlugin({
		assets: path.join(distPath, "assets"),
		prefix: "/assets",
		alwaysStatic: false,
		etag: false,
		headers: {
			"Cache-Control": "immutable, max-age=31536000",
		},
	});
	const publicFiles = await staticPlugin({
		assets: distPath,
		prefix: "",
		alwaysStatic: true,
		ignorePatterns: ROOT_STATIC_IGNORES,
		maxAge: 0,
		directive: "no-cache",
	});
	const indexPath = path.join(distPath, "index.html");

	return new Elysia({ name: "spa-static-plugin" })
		.use(versionedAssets)
		.use(publicFiles)
		.get("*", ({ path: requestPath, request }) => {
			const decodedPath = decodeRequestPath(requestPath);
			if (
				decodedPath === null ||
				isApiPath(decodedPath) ||
				decodedPath === API_PATHS.health ||
				decodedPath === API_PATHS.openapi ||
				decodedPath.startsWith(`${API_PATHS.openapi}/`) ||
				!isSpaDocumentRequest(request, requestPath)
			) {
				return status(404, { error: "Not Found" });
			}

			return new Response(Bun.file(indexPath), {
				headers: {
					"Cache-Control": SPA_DOCUMENT_CACHE_CONTROL,
					"Content-Type": "text/html; charset=utf-8",
				},
			});
		});
}

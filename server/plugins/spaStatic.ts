import path from "node:path";
import { staticPlugin } from "@elysiajs/static";
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
	/(?:^|[\\/])index\.html$/,
	/(?:^|[\\/])\.DS_Store$/,
	/(?:^|[\\/])\.git(?:[\\/]|$)/,
	/(?:^|[\\/])\.env(?:\.[^\\/]+)?$/,
];

function isAssetRequest(requestPath: string): boolean {
	return /\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|json|webmanifest|mp3|wav|ogg|map|txt|xml)$/i.test(
		requestPath,
	);
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
		etag: false,
		headers: {
			"Cache-Control": "no-cache",
		},
	});
	const indexPath = path.join(distPath, "index.html");

	return new Elysia({ name: "spa-static-plugin" })
		.use(versionedAssets)
		.use(publicFiles)
		.get("*", ({ path: requestPath }) => {
			if (
				isApiPath(requestPath) ||
				requestPath === API_PATHS.health ||
				isAssetRequest(requestPath)
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

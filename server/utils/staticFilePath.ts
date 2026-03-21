import path from "node:path";

export function resolveStaticFilePath(
	rootPath: string,
	requestPath: string,
): string | null {
	const relativePath = requestPath.replace(/^\/+/, "");
	const resolvedPath = path.resolve(rootPath, relativePath);
	const normalizedRoot = path.resolve(rootPath);

	if (
		resolvedPath === normalizedRoot ||
		resolvedPath.startsWith(`${normalizedRoot}${path.sep}`)
	) {
		return resolvedPath;
	}

	return null;
}

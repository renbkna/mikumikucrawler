import { existsSync } from "node:fs";

const SYSTEM_CHROMIUM_COMMANDS = [
	"chromium",
	"chromium-browser",
	"google-chrome",
	"google-chrome-stable",
] as const;

interface BrowserResolutionDependencies {
	pathExists: (path: string) => boolean;
	findExecutable: (command: string) => string | null;
}

export type ChromiumExecutableResolution =
	| { source: "configured" | "system"; executablePath: string }
	| { source: "playwright" }
	| { source: "invalid-configured"; executablePath: string }
	| { source: "missing" };

const defaultDependencies: BrowserResolutionDependencies = {
	pathExists: existsSync,
	findExecutable: (command) => Bun.which(command),
};

export function resolveChromiumExecutable(
	configuredPath: string | undefined,
	playwrightExecutablePath: string,
	dependencies: BrowserResolutionDependencies = defaultDependencies,
): ChromiumExecutableResolution {
	if (configuredPath !== undefined) {
		return dependencies.pathExists(configuredPath)
			? { source: "configured", executablePath: configuredPath }
			: { source: "invalid-configured", executablePath: configuredPath };
	}

	if (dependencies.pathExists(playwrightExecutablePath)) {
		return { source: "playwright" };
	}

	for (const command of SYSTEM_CHROMIUM_COMMANDS) {
		const executablePath = dependencies.findExecutable(command);
		if (executablePath !== null) {
			return { source: "system", executablePath };
		}
	}

	return { source: "missing" };
}

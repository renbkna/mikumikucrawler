import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function warn(message: string) {
	process.stderr.write(`${message}\n`);
}

const hasGitMetadata = existsSync(".git");
if (!hasGitMetadata) {
	process.exit(0);
}

const gitCheck = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
	stdio: "ignore",
});

if (gitCheck.error || gitCheck.status !== 0) {
	warn("Failed to verify the active Git checkout; Lefthook was not installed.");
	process.exit(1);
}

const lefthookInstall = spawnSync("lefthook", ["install", "--force"], {
	stdio: "inherit",
});

if (lefthookInstall.error) {
	warn(`Failed to install Lefthook: ${lefthookInstall.error.message}`);
	process.exit(1);
}

if (lefthookInstall.status !== 0) {
	warn("Failed to install Lefthook in the active Git checkout.");
	process.exit(lefthookInstall.status ?? 1);
}

process.exit(0);

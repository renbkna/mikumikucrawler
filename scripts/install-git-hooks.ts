import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const hasGitMetadata = existsSync(".git");
if (!hasGitMetadata) {
	process.exit(0);
}

const gitCheck = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
	stdio: "ignore",
});

if (gitCheck.error || gitCheck.status !== 0) {
	console.warn(
		"Skipping lefthook install: this is not an active Git checkout.",
	);
	process.exit(0);
}

const lefthookInstall = spawnSync("lefthook", ["install", "--force"], {
	stdio: "inherit",
});

if (lefthookInstall.error) {
	console.warn(`Skipping lefthook install: ${lefthookInstall.error.message}`);
	process.exit(0);
}

if (lefthookInstall.status !== 0) {
	console.warn(
		"Skipping lefthook install: lefthook could not update local hooks.",
	);
}

process.exit(0);

import { describe, expect, expectTypeOf, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Static } from "typebox";
import { API_LIST_LIMIT_BOUNDS } from "../../../shared/contracts/http.js";
import type {
	CrawlCounters,
	CrawlEventEnvelope,
	CrawlOptions,
} from "../../../shared/contracts/index.js";
import {
	type CrawlCountersSchema,
	CrawlEventEnvelopeSchema,
	type CrawlOptionsSchema,
} from "../../../shared/contracts/schemas.js";
import { DEFAULT_BACKEND_PORT } from "../../../shared/deploymentDefaults.js";
import { CrawlListQuerySchema, ResumableCrawlListQuerySchema } from "../crawls.js";

const SERVER_CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = join(SERVER_CONTRACTS_DIR, "../..");

function expectBackendPortProjections(source: string, patterns: RegExp[]): void {
	const projectedPorts = patterns.flatMap((pattern) =>
		[...source.matchAll(pattern)].flatMap((match) =>
			match
				.slice(1)
				.filter((value): value is string => value !== undefined)
				.map(Number),
		),
	);

	expect(projectedPorts.length).toBeGreaterThan(0);
	expect([...new Set(projectedPorts)]).toEqual([DEFAULT_BACKEND_PORT]);
}

describe("cross-boundary invariants", () => {
	test("checked-in deployment projections match the authoritative backend default", async () => {
		const [environmentExample, dockerfile, readme] = await Promise.all([
			readFile(new URL("../../../.env.example", import.meta.url), "utf8"),
			readFile(new URL("../../../Dockerfile", import.meta.url), "utf8"),
			readFile(new URL("../../../README.md", import.meta.url), "utf8"),
		]);
		const readmeBackendProjections = readme
			.split("\n")
			.filter((line) => !line.includes("Frontend") && !line.startsWith("FRONTEND_URL="))
			.join("\n");

		expectBackendPortProjections(environmentExample, [/^PORT=(\d+)$/gm]);
		expectBackendPortProjections(dockerfile, [/^ENV PORT=(\d+)$|^EXPOSE (\d+)$/gm]);
		expectBackendPortProjections(readmeBackendProjections, [
			/localhost:(\d+)/g,
			/^PORT=(\d+)$/gm,
			/-p (\d+):(\d+)/g,
			/backend owns port `(\d+)`/gi,
		]);
	});

	test("container deployment pins and hardens one production browser runtime", async () => {
		const [dockerfile, dockerignore, renderer, readme, seccompProfile, packageJson] =
			await Promise.all([
				readFile(new URL("../../../Dockerfile", import.meta.url), "utf8"),
				readFile(new URL("../../../.dockerignore", import.meta.url), "utf8"),
				readFile(new URL("../../domain/crawl/DynamicRenderer.ts", import.meta.url), "utf8"),
				readFile(new URL("../../../README.md", import.meta.url), "utf8"),
				readFile(new URL("../../../seccomp_profile.json", import.meta.url)),
				readFile(new URL("../../../package.json", import.meta.url), "utf8"),
			]);
		const manifest = JSON.parse(packageJson) as {
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
		};
		const playwrightVersion = manifest.dependencies.playwright;

		expect(dockerfile).toMatch(/^ARG BUN_IMAGE=oven\/bun:1\.3\.14@sha256:[a-f0-9]{64}$/m);
		expect(playwrightVersion).toMatch(/^\d+\.\d+\.\d+$/);
		expect(dockerfile).toMatch(
			/^ARG PLAYWRIGHT_IMAGE=mcr\.microsoft\.com\/playwright:v\d+\.\d+\.\d+-noble@sha256:[a-f0-9]{64}$/m,
		);
		expect(dockerfile).toContain(
			`ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v${playwrightVersion}-noble@sha256:`,
		);
		expect(dockerfile).toContain("RUN bun install --frozen-lockfile --production --ignore-scripts");
		for (const buildOnlyDependency of ["@elysia/eden", "lucide-react", "react", "react-dom"]) {
			expect(manifest.dependencies).not.toHaveProperty(buildOnlyDependency);
			expect(manifest.devDependencies).toHaveProperty(buildOnlyDependency);
		}
		expect(dockerfile).toContain('VOLUME ["/app/data"]');
		expect(dockerfile).toContain("USER pwuser");
		expect(dockerfile).not.toContain("playwright/cli.js install");
		expect(renderer).toContain("chromiumSandbox: true");
		expect(renderer).not.toContain('"--no-sandbox"');
		expect(renderer).not.toContain('"--disable-setuid-sandbox"');
		for (const copy of dockerfile.matchAll(/^COPY (?!--from=)(?:--\S+\s+)*(.+)$/gm)) {
			for (const source of copy[1]?.trim().split(/\s+/).slice(0, -1) ?? []) {
				expect(existsSync(join(REPOSITORY_ROOT, source))).toBe(true);
			}
		}

		for (const pattern of [".env.*", "*.db", "*.sqlite", "*.sqlite3", "data/**"]) {
			expect(dockerignore).toContain(pattern);
		}
		expect(readme).toContain("--security-opt seccomp=seccomp_profile.json");
		expect(readme).toContain("-v mikumikucrawler-data:/app/data");
		const profileHash = createHash("sha256").update(seccompProfile).digest("hex");
		expect(readme).toContain(profileHash);
		const profile = JSON.parse(seccompProfile.toString()) as {
			defaultErrnoRet?: number;
			syscalls?: Array<{ action?: string; names?: string[] }>;
		};
		expect(profile.defaultErrnoRet).toBe(1);
		expect(profile.syscalls).toContainEqual(
			expect.objectContaining({
				action: "SCMP_ACT_ALLOW",
				names: ["clone", "setns", "unshare"],
			}),
		);
		expect(profile.syscalls?.flatMap(({ names }) => names ?? [])).not.toContain("socketcall");
	});

	test("shared runtime schemas own browser and server wire types", async () => {
		expect(existsSync(join(SERVER_CONTRACTS_DIR, "crawl.ts"))).toBe(false);
		expect(existsSync(join(SERVER_CONTRACTS_DIR, "events.ts"))).toBe(false);
		expect(API_LIST_LIMIT_BOUNDS).toEqual({ min: 1, max: 100 });
		expect(CrawlListQuerySchema).toBeDefined();
		expect(ResumableCrawlListQuerySchema).toBeDefined();
		expect(CrawlEventEnvelopeSchema).toBeDefined();
		expectTypeOf<CrawlOptions>().toEqualTypeOf<Static<typeof CrawlOptionsSchema>>();
		expectTypeOf<CrawlCounters>().toEqualTypeOf<Static<typeof CrawlCountersSchema>>();
		expectTypeOf<CrawlEventEnvelope>().toEqualTypeOf<Static<typeof CrawlEventEnvelopeSchema>>();

		const [validationSource, schemaSource] = await Promise.all([
			readFile(new URL("../../../shared/contracts/validation.ts", import.meta.url), "utf8"),
			readFile(new URL("../../../shared/contracts/schemas.ts", import.meta.url), "utf8"),
		]);
		expect(validationSource).not.toContain("TypeCompiler");
		expect(validationSource).not.toContain(".Compile(");
		expect(schemaSource).toContain('from "elysia/type-system"');
		expect(schemaSource).not.toContain('from "./http.js"');
		expect(schemaSource).not.toContain("t.Numeric(");
	});
});

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { resolveStaticFilePath } from "../staticFilePath.js";

describe("resolveStaticFilePath", () => {
	test("keeps in-root asset paths within the dist directory", () => {
		const root = "/tmp/dist";
		expect(resolveStaticFilePath(root, "/assets/main.js")).toBe(
			path.resolve(root, "assets/main.js"),
		);
	});

	test("rejects traversal outside the dist directory", () => {
		expect(
			resolveStaticFilePath("/tmp/dist", "/../../server/config/env.ts"),
		).toBeNull();
	});
});

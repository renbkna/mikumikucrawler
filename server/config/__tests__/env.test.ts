import { describe, expect, test } from "bun:test";
import { allowsLocalhostTargets } from "../env.js";

describe("environment policy", () => {
	test("localhost targets are an explicit development-only capability", () => {
		expect(allowsLocalhostTargets("development")).toBe(true);
		expect(allowsLocalhostTargets("production")).toBe(false);
		expect(allowsLocalhostTargets("staging")).toBe(false);
		expect(allowsLocalhostTargets("preview")).toBe(false);
	});
});

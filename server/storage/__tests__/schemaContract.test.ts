import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	CrawlStatusValues,
	TERMINAL_CRAWL_STATUS_VALUES,
} from "../../../shared/contracts/index.js";
import { DOMAIN_DELAY_CONSTANTS } from "../../constants.js";
import { TERMINAL_OUTCOME_VALUES } from "../../domain/crawl/completion.js";

// schema.sql cannot import TypeScript constants; these checks keep its literals in step.
const schema = readFileSync(path.join(import.meta.dir, "..", "schema.sql"), "utf8");

function sqlTextLists(pattern: RegExp): string[][] {
	return Array.from(schema.matchAll(pattern), (match) =>
		Array.from((match[1] ?? "").matchAll(/'([^']*)'/g), (literal) => literal[1] ?? "").sort(),
	);
}

describe("schema literals follow the TypeScript contracts", () => {
	test("crawl_runs.status CHECK admits exactly the crawl status values", () => {
		expect(sqlTextLists(/CHECK\(status IN \(([^)]*)\)\)/g)).toEqual([
			[...CrawlStatusValues].sort(),
		]);
	});

	test("terminal-crawl triggers use exactly the terminal statuses", () => {
		const lists = sqlTextLists(/crawl_runs\.status IN \(([^)]*)\)/g);
		expect(lists.length).toBeGreaterThan(0);
		for (const list of lists) expect(list).toEqual([...TERMINAL_CRAWL_STATUS_VALUES].sort());
	});

	test("terminal URL outcomes match the completion outcomes", () => {
		expect(sqlTextLists(/CHECK\(outcome IN \(([^)]*)\)\)/g)).toEqual([
			[...TERMINAL_OUTCOME_VALUES].sort(),
		]);
	});

	test("persisted domain delays share the scheduler's delay ceiling", () => {
		expect(schema).toContain(`delay_ms BETWEEN 0 AND ${DOMAIN_DELAY_CONSTANTS.MAX_MS}`);
	});
});

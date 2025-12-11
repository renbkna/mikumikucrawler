import assert from "node:assert/strict";
import test from "node:test";
import * as cheerio from "cheerio";
import { cleanText, processLinks } from "../extractionUtils.js";

test("cleanText collapses whitespace", () => {
	const messy = "Hello\n\n  world    from   Miku";
	assert.strictEqual(cleanText(messy), "Hello world from Miku");
});

test("processLinks resolves absolute URLs", () => {
	const html =
		'<a href="/about">About</a><a href="https://social.example.com">Social</a>';
	const $ = cheerio.load(html);
	const links = processLinks($, "https://example.com");

	assert.strictEqual(links.length, 2);
	assert.strictEqual(links[0].url, "https://example.com/about");
	assert.strictEqual(links[0].isInternal, true);
	assert.strictEqual(links[1].isInternal, false);
});

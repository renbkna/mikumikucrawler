import { describe, expect, test } from "bun:test";
import {
	isSoft404,
	mergeRobotsDirectives,
	parseRobotsDirectives,
} from "../PageDecisionPolicy.js";

describe("page decision policy", () => {
	test("treats robots none as noindex and nofollow", () => {
		expect(parseRobotsDirectives("none")).toEqual({
			noindex: true,
			nofollow: true,
		});
	});

	test("merges meta robots and X-Robots-Tag directives", () => {
		expect(mergeRobotsDirectives("noindex", "nofollow")).toEqual({
			noindex: true,
			nofollow: true,
		});
	});

	test("does not classify short valid content as soft 404 without 404 signals", () => {
		expect(isSoft404("About", "Hello world", 50)).toBe(false);
	});

	test("classifies short keyword content as soft 404", () => {
		expect(isSoft404("Not found", "Page not found", 80)).toBe(true);
	});
});

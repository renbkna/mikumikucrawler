import { describe, expect, test } from "bun:test";
import {
	isClientErrorShell,
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

	test("classifies rendered frontend error shells", () => {
		expect(
			isClientErrorShell(
				"",
				"Oops! Something went wrong Miku encountered an unexpected error Try Again Reload Page",
			),
		).toBe(true);
		expect(
			isClientErrorShell(
				"",
				"Application error: a client-side exception has occurred while loading example.com",
			),
		).toBe(true);
	});

	test("does not classify ordinary text mentioning errors without recovery shell controls", () => {
		expect(
			isClientErrorShell(
				"Debugging React",
				"Something went wrong in production and the team wrote a postmortem.",
			),
		).toBe(false);
	});

	test("does not classify ordinary prose that mentions recovery actions", () => {
		expect(
			isClientErrorShell(
				"Debugging React",
				"Something went wrong in production. Try again after reading the postmortem and refresh the page if needed.",
			),
		).toBe(false);
	});
});

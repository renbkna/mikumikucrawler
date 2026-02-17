import { describe, expectTypeOf, test } from "bun:test";
import type { ProcessedPageData } from "../../src/types.js";
import type { ProcessedContent } from "../types.js";

describe("Type Consistency", () => {
	test("ProcessedContent core fields should be compatible with ProcessedPageData", () => {
		// ProcessedContent (server) has additional fields (url, links, contentType) that
		// get mapped to the parent CrawledPage object before sending to frontend.
		// Here we verify the nested processed data fields are compatible.

		// Frontend expects:
		// errors?: Array<{ type: string; message: string; timestamp?: string }>;

		// Server provides:
		// errors: Array<{ type: string; message: string; timestamp?: string }>;

		// Check that the core processing fields (minus server-specific fields) are compatible
		type ProcessedContentCore = Omit<
			ProcessedContent,
			"url" | "links" | "contentType"
		>;
		expectTypeOf<ProcessedContentCore>().toMatchTypeOf<
			Omit<ProcessedPageData, "qualityScore" | "language">
		>();
	});

	test("Shared Interfaces should match", () => {
		// Verify common fields exist
		type CommonFields = "extractedData" | "metadata" | "analysis" | "media";
		expectTypeOf<Pick<ProcessedContent, CommonFields>>().toMatchTypeOf<
			Pick<ProcessedPageData, CommonFields>
		>();
	});
});

import { describe, expectTypeOf, test } from "bun:test";
import type { ProcessedPageData } from "../../src/types.js";
import type { ProcessedContent } from "../types.js";

describe("Type Consistency", () => {
	test("ProcessedContent (Server) should be compatible with ProcessedPageData (Frontend)", () => {
		// This test is purely a compile-time check using expectTypeOf
		// If the types diverge in an incompatible way, this file won't compile (or expectTypeOf will fail).

		// Frontend expects:
		// errors?: Array<{ type: string; message: string; timestamp?: string }>;

		// Server provides:
		// errors: Array<{ type: string; message: string; timestamp?: string }>;

		expectTypeOf<ProcessedContent>().toMatchTypeOf<ProcessedPageData>();

		// Reverse check: Can a frontend object satisfy the server requirement?
		// Likely NOT, because Server has stricter needs (e.g. links array), but checking overlap is good.
	});

	test("Shared Interfaces should match", () => {
		// Verify common fields exist
		type CommonFields = "extractedData" | "metadata" | "analysis" | "media";
		expectTypeOf<Pick<ProcessedContent, CommonFields>>().toMatchTypeOf<
			Pick<ProcessedPageData, CommonFields>
		>();
	});
});

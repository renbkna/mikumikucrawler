import { expect, test } from "bun:test";
import { searchResultCard } from "../CrawledPagesSection";

const result = {
	id: 42,
	url: "https://example.com/stored",
	title: "Stored page",
	description: "metadata description",
	domain: "example.com",
	snippet: "body needle from durable content",
};

test("search result cards show the matching snippet, falling back to the stored description", () => {
	expect(searchResultCard(result)).toEqual({
		id: 42,
		url: "https://example.com/stored",
		title: "Stored page",
		description: "body needle from durable content",
	});
	expect(searchResultCard({ ...result, snippet: "" }).description).toBe("metadata description");
});

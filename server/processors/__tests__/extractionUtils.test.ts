import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";
import { PAGE_TEXT_LIMITS } from "../../../shared/contracts/index.js";
import {
	cleanText,
	extractMainContent,
	extractMediaCount,
	extractMetadata,
	MAX_EXTRACTED_LINKS_PER_PAGE,
	processLinks,
} from "../extractionUtils.js";

describe("page extraction", () => {
	test("extracts the strongest content candidate after removing page chrome", () => {
		const $ = cheerio.load(`
			<body>
				<nav>navigation noise</nav>
				<article>short article</article>
				<main>the focused and substantially useful page content</main>
			</body>
		`);

		expect(extractMainContent($)).toBe("the focused and substantially useful page content");
		expect(cleanText("  one\n two\tthree ")).toBe("one two three");
	});

	test("bounds hostile DOM depth before recursive library work", () => {
		const $ = cheerio.load(`<body>${"<div>".repeat(129)}x${"</div>".repeat(129)}</body>`);
		expect(() => extractMainContent($)).toThrow("DOM exceeds depth 128");
	});

	test("counts unique supported media through the document base", () => {
		const $ = cheerio.load(`
			<head><base href="https://cdn.example/assets/"></head>
			<body>
				<img src="miku.png">
				<img src="./miku.png">
				<picture><source srcset="large.webp 2x, small.webp 1x"></picture>
				<video src="clip.mp4"></video>
				<audio><source src="song.ogg"></audio>
				<img src="javascript:alert(1)">
			</body>
		`);

		expect(extractMediaCount($, "https://example.com/page")).toBe(5);
	});

	test("canonicalizes and bounds links while preserving nofollow admission policy", () => {
		const anchors = Array.from(
			{ length: MAX_EXTRACTED_LINKS_PER_PAGE + 1 },
			(_, index) => `<a href="/${index}">${index}</a>`,
		).join("");
		const $ = cheerio.load(`
			<head><base href="https://example.com/base/"></head>
			<body>
				<a href="same" rel="nofollow">blocked copy</a>
				<a href="same">followed copy</a>
				<a href="mailto:test@example.com">mail</a>
				${anchors}
			</body>
		`);
		const links = processLinks($, "https://fallback.example/page");

		expect(links[0]).toEqual({ url: "https://example.com/base/same", nofollow: false });
		expect(links).toHaveLength(MAX_EXTRACTED_LINKS_PER_PAGE - 2);
		expect(links.every((link) => link.url.startsWith("https://example.com/"))).toBe(true);
	});

	test("projects only bounded metadata used by crawling and page display", () => {
		const $ = cheerio.load(`
			<head>
				<meta property="og:title" content="${"🎵".repeat(PAGE_TEXT_LIMITS.metadataValueBytes)}">
				<meta name="description" content="A page description">
				<meta name="robots" content=" noindex, nofollow ">
				<meta name="author" content="unused author">
			</head>
		`);
		const metadata = extractMetadata($);

		expect(new TextEncoder().encode(metadata.title ?? "").byteLength).toBeLessThanOrEqual(
			PAGE_TEXT_LIMITS.metadataValueBytes,
		);
		expect(metadata).toEqual({
			title: metadata.title,
			description: "A page description",
			robots: "noindex, nofollow",
		});
	});
});

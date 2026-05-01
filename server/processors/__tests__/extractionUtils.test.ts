import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";
import {
	cleanText,
	extractMainContent,
	extractMediaInfo,
	extractMetadata,
	extractStructuredData,
	processLinks,
} from "../extractionUtils.js";

/**
 * CONTRACT: Extraction Utilities
 *
 * Purpose: Extract structured data, links, media, and metadata from HTML content.
 *
 * FUNCTIONS:
 *
 * 1. cleanText(text)
 *    - Collapses whitespace (\s+ → single space)
 *    - Trims leading/trailing whitespace
 *    - Returns "" for null/undefined
 *
 * 2. extractStructuredData($)
 *    - Extracts JSON-LD from <script type="application/ld+json">
 *    - Extracts Open Graph from <meta property="og:*">
 *    - Extracts Twitter Cards from <meta name="twitter:*">
 *    - Extracts Microdata from [itemscope] elements
 *    - Returns: { jsonLd[], microdata{}, openGraph{}, twitterCards{}, schema{} }
 *
 * 3. extractMainContent($)
 *    - Extracts primary text content
 *    - Prefers <main>, <article>, [role="main"]
 *    - Falls back to <body>
 *    - Strips script/style/nav tags
 *    - Returns cleaned text
 *
 * 4. extractMediaInfo($, baseUrl)
 *    - Extracts images: <img src>, <picture><source>
 *    - Extracts videos: <video>, <video><source>
 *    - Extracts audio: <audio>, <audio><source>
 *    - Resolves relative URLs to absolute
 *    - Returns: Array<{ type, url, alt?, width?, height?, mimeType? }>
 *
 * 5. processLinks($, baseUrl)
 *    - Extracts <a href> elements
 *    - Resolves relative URLs to absolute
 *    - Classifies: internal/external, type (social, download, email, navigation, content)
 *    - Returns: Array<{ url, text, title, isInternal, type, domain }>
 *
 * 6. extractMetadata($)
 *    - Extracts: title, description, author, publishDate, modifiedDate
 *    - Extracts: canonical, robots, viewport, charset, generator
 *    - Returns: PageMetadata object
 *
 * INVARIANTS:
 *   1. NEVER THROWS: All functions handle invalid inputs gracefully
 *   2. URL RESOLUTION: All relative URLs resolved to absolute
 *   3. DEDUPLICATION: No duplicate URLs in results
 *   4. CLASSIFICATION: Links classified by type (social, download, email, navigation, content)
 *   5. METADATA FALLBACK: Multiple sources checked, first valid wins
 *   6. WHITESPACE: Text content cleaned of redundant whitespace
 *   7. INVALID HANDLING: Malformed URLs skipped, logged
 *
 * EDGE CASES:
 *   - Empty HTML
 *   - Missing elements
 *   - Malformed URLs
 *   - Relative URLs
 *   - Protocol-relative URLs
 *   - mailto:, javascript:, tel: links
 *   - Invalid JSON-LD
 *   - Binary content in media
 */

describe("cleanText CONTRACT", () => {
	test("collapses whitespace", () => {
		const messy = "Hello\n\n  world    from   Miku";
		expect(cleanText(messy)).toBe("Hello world from Miku");
	});

	test("trims leading and trailing whitespace", () => {
		const messy = "   hello world   ";
		expect(cleanText(messy)).toBe("hello world");
	});

	test("handles null", () => {
		expect(cleanText(null)).toBe("");
	});

	test("handles undefined", () => {
		expect(cleanText(undefined)).toBe("");
	});

	test("handles empty string", () => {
		expect(cleanText("")).toBe("");
	});

	test("handles whitespace only", () => {
		expect(cleanText("   \n\t   ")).toBe("");
	});

	test("handles single word", () => {
		expect(cleanText("hello")).toBe("hello");
	});

	test("handles multiple spaces", () => {
		expect(cleanText("a   b     c")).toBe("a b c");
	});

	test("handles tabs", () => {
		expect(cleanText("a\tb\tc")).toBe("a b c");
	});
});

describe("extractStructuredData CONTRACT", () => {
	test("extracts JSON-LD data", () => {
		const html = `
			<script type="application/ld+json">
			{
				"@context": "https://schema.org",
				"@type": "Article",
				"headline": "Test Article"
			}
			</script>
		`;
		const $ = cheerio.load(html);
		const data = extractStructuredData($);

		// INVARIANT: JSON-LD extracted
		expect(data.jsonLd.length).toBe(1);
		expect(data.jsonLd[0]).toHaveProperty("headline", "Test Article");
	});

	test("flattens top-level JSON-LD arrays into public record entries", () => {
		const html = `
			<script type="application/ld+json">
			[
				{
					"@context": "https://schema.org",
					"@type": "Article",
					"headline": "Array Article"
				},
				{
					"@context": "https://schema.org",
					"@type": ["NewsArticle", "ReportageNewsArticle"],
					"headline": "Nested Type Article"
				}
			]
			</script>
		`;
		const $ = cheerio.load(html);
		const data = extractStructuredData($);

		expect(data.jsonLd).toHaveLength(2);
		expect(data.jsonLd[0]).toHaveProperty("headline", "Array Article");
		expect(data.jsonLd[1]).toHaveProperty("headline", "Nested Type Article");
		expect(data.schema.Article).toEqual(data.jsonLd[0]);
		expect(data.schema.NewsArticle).toEqual(data.jsonLd[1]);
		expect(data.schema.ReportageNewsArticle).toEqual(data.jsonLd[1]);
	});

	test("maps schema JSON-LD by declared type", () => {
		const html = `
				<script type="application/ld+json">
				{
					"@context": "https://schema.org",
				"@type": "Article",
				"headline": "Schema Article"
			}
			</script>
		`;
		const $ = cheerio.load(html);
		const data = extractStructuredData($);

		expect(data.schema.Article).toEqual({
			"@context": "https://schema.org",
			"@type": "Article",
			headline: "Schema Article",
		});
	});

	test("indexes multi-type JSON-LD by each declared schema type", () => {
		const html = `
			<script type="application/ld+json">
			{
				"@context": "https://schema.org",
				"@type": ["Article", "BlogPosting"],
				"headline": "Multi typed post"
			}
			</script>
		`;
		const $ = cheerio.load(html);
		const data = extractStructuredData($);

		expect(data.schema.Article).toEqual({
			"@context": "https://schema.org",
			"@type": ["Article", "BlogPosting"],
			headline: "Multi typed post",
		});
		expect(data.schema.BlogPosting).toEqual(data.schema.Article);
		expect(data.schema["Article,BlogPosting"]).toBeUndefined();
	});

	test("preserves JSON-LD and microdata when schema type keys collide", () => {
		const html = `
				<script type="application/ld+json">
				{
					"@context": "https://schema.org",
					"@type": "https://schema.org/Article",
					"headline": "JSON-LD Article"
				}
				</script>
				<div itemscope itemtype="https://schema.org/Article">
					<span itemprop="name">Microdata Article</span>
				</div>
			`;
		const $ = cheerio.load(html);
		const data = extractStructuredData($);

		expect(data.schema["https://schema.org/Article"]).toEqual([
			{
				"@context": "https://schema.org",
				"@type": "https://schema.org/Article",
				headline: "JSON-LD Article",
			},
			{
				name: "Microdata Article",
			},
		]);
	});

	test("handles invalid JSON-LD gracefully", () => {
		const html = `
			<script type="application/ld+json">{ invalid json }</script>
		`;
		const $ = cheerio.load(html);
		const data = extractStructuredData($);

		// INVARIANT: Invalid JSON-LD doesn't crash
		expect(data.jsonLd).toEqual([]);
	});

	test("extracts Open Graph metadata", () => {
		const html = `
			<meta property="og:title" content="OG Title">
			<meta property="og:description" content="OG Description">
			<meta property="og:image" content="https://example.com/image.jpg">
		`;
		const $ = cheerio.load(html);
		const data = extractStructuredData($);

		// INVARIANT: Open Graph extracted
		expect(data.openGraph.title).toBe("OG Title");
		expect(data.openGraph.description).toBe("OG Description");
		expect(data.openGraph.image).toBe("https://example.com/image.jpg");
	});

	test("extracts Twitter Cards metadata", () => {
		const html = `
			<meta name="twitter:card" content="summary">
			<meta name="twitter:site" content="@example">
			<meta name="twitter:title" content="Twitter Title">
		`;
		const $ = cheerio.load(html);
		const data = extractStructuredData($);

		// INVARIANT: Twitter Cards extracted
		expect(data.twitterCards.card).toBe("summary");
		expect(data.twitterCards.site).toBe("@example");
		expect(data.twitterCards.title).toBe("Twitter Title");
	});

	test("extracts Microdata with correct values", () => {
		const html = `
			<div itemscope itemtype="https://schema.org/Person">
				<span itemprop="name">John Doe</span>
				<span itemprop="jobTitle">Developer</span>
			</div>
		`;
		const $ = cheerio.load(html);
		const data = extractStructuredData($);

		// INVARIANT: Microdata extracted with correct itemType key and property values
		const personItems = data.microdata["https://schema.org/Person"] as Record<
			string,
			string
		>[];
		expect(personItems).toBeDefined();
		expect(personItems.length).toBe(1);
		expect(personItems[0].name).toBe("John Doe");
		expect(personItems[0].jobTitle).toBe("Developer");
		expect(data.schema["https://schema.org/Person"]).toEqual([
			{
				name: "John Doe",
				jobTitle: "Developer",
			},
		]);
	});

	test("preserves nested microdata scopes instead of flattening child properties", () => {
		const html = `
			<div itemscope itemtype="https://schema.org/Person">
				<span itemprop="name">Ada Lovelace</span>
				<div itemprop="address" itemscope itemtype="https://schema.org/PostalAddress">
					<span itemprop="streetAddress">12 Analytical Engine Way</span>
				</div>
			</div>
		`;
		const $ = cheerio.load(html);
		const data = extractStructuredData($);

		expect(data.microdata["https://schema.org/Person"]).toEqual([
			{
				name: "Ada Lovelace",
				address: {
					streetAddress: "12 Analytical Engine Way",
				},
			},
		]);
	});

	test("handles empty HTML", () => {
		const html = "";
		const $ = cheerio.load(html);
		const data = extractStructuredData($);

		// INVARIANT: Empty results for empty HTML
		expect(data.jsonLd).toEqual([]);
		expect(data.openGraph).toEqual({});
		expect(data.twitterCards).toEqual({});
	});

	test("handles HTML without structured data", () => {
		const html = "<html><body><p>No structured data</p></body></html>";
		const $ = cheerio.load(html);
		const data = extractStructuredData($);

		expect(data.jsonLd).toEqual([]);
		expect(data.openGraph).toEqual({});
	});
});

describe("extractMainContent CONTRACT", () => {
	test("extracts content from main element", () => {
		const html = "<html><body><main><p>Main content</p></main></body></html>";
		const $ = cheerio.load(html);
		const content = extractMainContent($);

		expect(content).toContain("Main content");
	});

	test("extracts content from article element", () => {
		const html =
			"<html><body><article><p>Article content</p></article></body></html>";
		const $ = cheerio.load(html);
		const content = extractMainContent($);

		expect(content).toContain("Article content");
	});

	test("prefers later substantial main content over a short teaser article", () => {
		const html = `
			<html>
				<body>
					<article>Mini teaser.</article>
					<main>
						<h1>Actual crawler release notes</h1>
						<p>This is the primary page body with enough detail to drive summaries, search snippets, quality scoring, and persistence decisions instead of saving the preceding teaser card.</p>
					</main>
				</body>
			</html>
		`;
		const $ = cheerio.load(html);
		const content = extractMainContent($);

		expect(content).toContain("Actual crawler release notes");
		expect(content).toContain("primary page body");
		expect(content).not.toBe("Mini teaser.");
	});

	test("uses cleaned body when a short broad selector precedes unwrapped real content", () => {
		const html = `
			<html>
				<body>
					<nav>Navigation Login Register</nav>
					<article>Card teaser.</article>
					<section>
						<h1>Unwrapped page content</h1>
						<p>The real article body is not wrapped in a preferred content selector, but it is still the content that should feed saved main content and page quality checks.</p>
					</section>
					<footer>Footer boilerplate</footer>
				</body>
			</html>
		`;
		const $ = cheerio.load(html);
		const content = extractMainContent($);

		expect(content).toContain("Unwrapped page content");
		expect(content).toContain("real article body");
		expect(content).not.toContain("Navigation");
		expect(content).not.toContain("Footer boilerplate");
		expect(content).not.toBe("Card teaser.");
	});

	test("falls back to body when no main/article", () => {
		const html = "<html><body><p>Body content</p></body></html>";
		const $ = cheerio.load(html);
		const content = extractMainContent($);

		expect(content).toContain("Body content");
	});

	test("strips script tags", () => {
		const html =
			'<html><body><p>Content</p><script>alert("xss")</script></body></html>';
		const $ = cheerio.load(html);
		const content = extractMainContent($);

		// INVARIANT: Script content excluded
		expect(content).not.toContain("alert");
	});

	test("strips style tags", () => {
		const html =
			"<html><body><p>Content</p><style>body{color:red}</style></body></html>";
		const $ = cheerio.load(html);
		const content = extractMainContent($);

		// INVARIANT: Style content excluded
		expect(content).not.toContain("color:red");
	});

	test("strips nav tags", () => {
		const html =
			'<html><body><nav><a href="#">Nav</a></nav><p>Content</p></body></html>';
		const $ = cheerio.load(html);
		const content = extractMainContent($);

		// INVARIANT: Nav content excluded
		expect(content).not.toContain("Nav");
	});

	test("cleans whitespace", () => {
		const html = "<html><body><p>  Extra   spaces  </p></body></html>";
		const $ = cheerio.load(html);
		const content = extractMainContent($);

		// INVARIANT: Whitespace collapsed
		expect(content).not.toContain("  ");
	});
});

describe("extractMediaInfo CONTRACT", () => {
	test("extracts images from img tags", () => {
		const html = '<html><body><img src="/image.jpg" alt="Test"></body></html>';
		const $ = cheerio.load(html);
		const media = extractMediaInfo($, "https://example.com");

		// INVARIANT: Images extracted
		expect(media.length).toBe(1);
		expect(media[0].type).toBe("image");
		expect(media[0].url).toBe("https://example.com/image.jpg");
		expect(media[0].alt).toBe("Test");
	});

	test("extracts images from picture sources", () => {
		const html = `
			<picture>
				<source srcset="image-large.jpg" media="(min-width: 800px)">
				<img src="image-small.jpg" alt="Responsive">
			</picture>
		`;
		const $ = cheerio.load(html);
		const media = extractMediaInfo($, "https://example.com");

		// INVARIANT: Picture sources extracted
		expect(media).toContainEqual({
			type: "image",
			url: "https://example.com/image-large.jpg",
		});
	});

	test("extracts video sources", () => {
		const html = `
			<video>
				<source src="/video.mp4" type="video/mp4">
			</video>
		`;
		const $ = cheerio.load(html);
		const media = extractMediaInfo($, "https://example.com");

		// INVARIANT: Video sources extracted
		const video = media.find((m) => m.type === "video");
		expect(video).toBeDefined();
		if (video) {
			expect(video.url).toBe("https://example.com/video.mp4");
		}
	});

	test("extracts direct video src attributes", () => {
		const html = '<video src="/direct-video.mp4"></video>';
		const $ = cheerio.load(html);
		const media = extractMediaInfo($, "https://example.com");

		expect(media).toContainEqual({
			type: "video",
			url: "https://example.com/direct-video.mp4",
		});
	});

	test("extracts audio sources", () => {
		const html = `
			<audio>
				<source src="/audio.mp3" type="audio/mpeg">
			</audio>
		`;
		const $ = cheerio.load(html);
		const media = extractMediaInfo($, "https://example.com");

		// INVARIANT: Audio sources extracted
		const audio = media.find((m) => m.type === "audio");
		expect(audio).toBeDefined();
		if (audio) {
			expect(audio.url).toBe("https://example.com/audio.mp3");
		}
	});

	test("extracts direct audio src attributes", () => {
		const html = '<audio src="/direct-audio.mp3"></audio>';
		const $ = cheerio.load(html);
		const media = extractMediaInfo($, "https://example.com");

		expect(media).toContainEqual({
			type: "audio",
			url: "https://example.com/direct-audio.mp3",
		});
	});

	test("prefers concise semantic main content over noisy body fallback", () => {
		const html = `
			<html>
				<body>
					<nav>Navigation Login Register</nav>
					<main>Short launch update.</main>
					<footer>Footer boilerplate</footer>
				</body>
			</html>
		`;
		const $ = cheerio.load(html);

		expect(extractMainContent($)).toBe("Short launch update.");
	});

	test("resolves relative URLs to absolute", () => {
		const html = '<img src="/path/to/image.jpg">';
		const $ = cheerio.load(html);
		const media = extractMediaInfo($, "https://example.com");

		// INVARIANT: Relative URLs resolved
		expect(media[0].url).toMatch(/^https?:\/\//);
	});

	test("handles data URIs", () => {
		const html = '<img src="data:image/png;base64,abc123">';
		const $ = cheerio.load(html);
		const media = extractMediaInfo($, "https://example.com");

		// INVARIANT: Data URIs preserved
		expect(media.length).toBe(1);
		expect(media[0].url).toContain("data:image/png");
	});

	test("handles missing src gracefully", () => {
		const html = `<img alt="No src">`;
		const $ = cheerio.load(html);
		const media = extractMediaInfo($, "https://example.com");

		// INVARIANT: No crash on missing src
		expect(media.length).toBe(0);
	});

	test("handles malformed URLs gracefully", () => {
		const html = '<img src="http://[invalid" alt="Bad URL">';
		const $ = cheerio.load(html);
		const media = extractMediaInfo($, "https://example.com");

		// INVARIANT: Malformed URLs skipped, no crash
		expect(media.length).toBe(0);
	});

	test("extracts width and height attributes", () => {
		const html = '<img src="/image.jpg" width="800" height="600">';
		const $ = cheerio.load(html);
		const media = extractMediaInfo($, "https://example.com");

		// INVARIANT: Dimensions extracted (as strings from HTML attributes)
		expect(media[0].width).toBe("800");
		expect(media[0].height).toBe("600");
	});

	test("deduplicates media by normalized type and URL", () => {
		const html = `
			<img src="/image.jpg?b=2&a=1#first" alt="First">
			<img src="https://example.com/image.jpg?a=1&b=2#second" alt="Second">
			<video src="/clip.mp4"></video>
			<video><source src="/clip.mp4"></video>
		`;
		const $ = cheerio.load(html);
		const media = extractMediaInfo($, "https://example.com");

		expect(media.map((entry) => `${entry.type}:${entry.url}`)).toEqual([
			"image:https://example.com/image.jpg?a=1&b=2",
			"video:https://example.com/clip.mp4",
		]);
	});

	test("resolves media through document base href like links", () => {
		const html = `
			<base href="https://cdn.example.net/assets/">
			<img src="image.jpg" alt="From base">
			<video src="clip.mp4"></video>
		`;
		const $ = cheerio.load(html);
		const media = extractMediaInfo($, "https://example.com/start");

		expect(media.map((entry) => entry.url)).toEqual([
			"https://cdn.example.net/assets/image.jpg",
			"https://cdn.example.net/assets/clip.mp4",
		]);
	});
});

describe("processLinks CONTRACT", () => {
	test("resolves relative URLs", () => {
		const html = '<a href="/about">About</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com");

		// INVARIANT: Relative URLs resolved
		expect(links[0].url).toBe("https://example.com/about");
	});

	test("preserves absolute URLs", () => {
		const html = '<a href="https://external.com">External</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com");

		expect(links[0].url).toBe("https://external.com/");
	});

	test("classifies internal links", () => {
		const html = '<a href="/internal">Internal</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com");

		// INVARIANT: Internal links marked
		expect(links[0].isInternal).toBe(true);
	});

	test("classifies external links", () => {
		const html = '<a href="https://other.com">External</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com");

		// INVARIANT: External links marked
		expect(links[0].isInternal).toBe(false);
	});

	test("classifies links resolved through external base href as external to the page", () => {
		const html =
			'<base href="https://cdn.example.net/assets/"><a href="/page">Page</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com/start");

		expect(links[0].url).toBe("https://cdn.example.net/page");
		expect(links[0].isInternal).toBe(false);
	});

	test("classifies same-host different-port links as external to the page origin", () => {
		const html = '<a href="https://example.com:8443/page">Port</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com/start");

		expect(links[0].isInternal).toBe(false);
	});

	test("classifies social links", () => {
		const html = '<a href="https://twitter.com/user">Twitter</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com");

		// INVARIANT: Social links classified
		expect(links[0].type).toBe("social");
	});

	test("classifies download links", () => {
		const html = '<a href="/document.pdf">Download PDF</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com");

		// INVARIANT: Download links classified
		expect(links[0].type).toBe("download");
	});

	test("classifies email links", () => {
		const html = '<a href="mailto:test@example.com">Email</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com");

		// INVARIANT: Email links classified
		expect(links[0].type).toBe("email");
	});

	test("classifies navigation links by text", () => {
		const html = '<a href="/about">About Us</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com");

		// INVARIANT: Navigation links classified by text content
		expect(links[0].type).toBe("navigation");
	});

	test("extracts link text", () => {
		const html = '<a href="/page">Link Text</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com");

		// INVARIANT: Text extracted
		expect(links[0].text).toBe("Link Text");
	});

	test("extracts title attribute", () => {
		const html = '<a href="/page" title="Page Title">Link</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com");

		// INVARIANT: Title attribute extracted
		expect(links[0].title).toBe("Page Title");
	});

	test("extracts domain", () => {
		const html = '<a href="https://other.com/page">External</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com");

		// INVARIANT: Domain extracted
		expect(links[0].domain).toBe("other.com");
	});

	test("handles protocol-relative URLs", () => {
		const html = '<a href="//cdn.example.com/file.js">CDN</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com");

		// INVARIANT: Protocol-relative URLs resolved
		expect(links[0].url).toMatch(/^https:\/\//);
	});

	test("handles anchor-only URLs", () => {
		const html = '<a href="#section">Jump</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com/page");

		// INVARIANT: URL normalization strips fragments
		// This is intentional - fragments are not included in normalized URLs
		// The link is still extracted, just without the fragment
		expect(links.length).toBe(1);
		expect(links[0].url).toBe("https://example.com/page");
	});

	test("handles query strings", () => {
		const html = '<a href="/page?foo=bar">Query</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com");

		// INVARIANT: Query strings preserved
		expect(links[0].url).toContain("?foo=bar");
	});

	test("skips javascript: URLs", () => {
		const html = '<a href="javascript:void(0)">JS</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com");

		// INVARIANT: javascript: URLs are skipped (normalizeUrl rejects non-http/https schemes)
		expect(links.length).toBe(0);
	});

	test("handles malformed URLs gracefully", () => {
		const html = '<a href="http://[invalid">Bad</a>';
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com");

		// INVARIANT: Malformed URLs skipped, no crash
		expect(links.length).toBe(0);
	});

	test("deduplicates links by normalized URL", () => {
		const html = `
				<a href="/page?b=2&a=1">One</a>
				<a href="https://example.com/page?a=1&b=2#fragment">Two</a>
			`;
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com");

		expect(links.map((link) => link.url)).toEqual([
			"https://example.com/page?a=1&b=2",
		]);
	});

	test("keeps duplicate link crawlable when any occurrence is followable", () => {
		const html = `
					<a href="/page" rel="nofollow"></a>
					<a href="https://example.com/page#details" title="Canonical page">Followable page</a>
			`;
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com/start");

		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			url: "https://example.com/page",
			text: "Followable page",
			title: "Canonical page",
			nofollow: false,
		});
	});

	test("keeps duplicate link nofollow when all occurrences are nofollow", () => {
		const html = `
				<a href="/page" rel="nofollow">First</a>
				<a href="https://example.com/page#details" rel="ugc">Second</a>
			`;
		const $ = cheerio.load(html);
		const links = processLinks($, "https://example.com/start");

		expect(links).toHaveLength(1);
		expect(links[0].nofollow).toBe(true);
	});
});

describe("extractMetadata CONTRACT", () => {
	test("extracts title from title tag", () => {
		const html = "<html><head><title>Page Title</title></head></html>";
		const $ = cheerio.load(html);
		const metadata = extractMetadata($);

		// INVARIANT: Title extracted
		expect(metadata.title).toBe("Page Title");
	});

	test("falls back to og:title", () => {
		const html = '<meta property="og:title" content="OG Title">';
		const $ = cheerio.load(html);
		const metadata = extractMetadata($);

		// INVARIANT: OG title fallback
		expect(metadata.title).toBe("OG Title");
	});

	test("falls back to h1", () => {
		const html = "<html><body><h1>H1 Title</h1></body></html>";
		const $ = cheerio.load(html);
		const metadata = extractMetadata($);

		// INVARIANT: H1 fallback
		expect(metadata.title).toBe("H1 Title");
	});

	test("extracts description from meta tag", () => {
		const html = '<meta name="description" content="Page description">';
		const $ = cheerio.load(html);
		const metadata = extractMetadata($);

		// INVARIANT: Description extracted
		expect(metadata.description).toBe("Page description");
	});

	test("extracts author", () => {
		const html = '<meta name="author" content="John Doe">';
		const $ = cheerio.load(html);
		const metadata = extractMetadata($);

		// INVARIANT: Author extracted
		expect(metadata.author).toBe("John Doe");
	});

	test("extracts publish date", () => {
		const html =
			'<meta property="article:published_time" content="2023-01-01">';
		const $ = cheerio.load(html);
		const metadata = extractMetadata($);

		// INVARIANT: Publish date extracted
		expect(metadata.publishDate).toBe("2023-01-01");
	});

	test("extracts modified date", () => {
		const html = '<meta property="article:modified_time" content="2023-02-01">';
		const $ = cheerio.load(html);
		const metadata = extractMetadata($);

		// INVARIANT: Modified date extracted
		expect(metadata.modifiedDate).toBe("2023-02-01");
	});

	test("extracts canonical URL", () => {
		const html = '<link rel="canonical" href="https://example.com/canonical">';
		const $ = cheerio.load(html);
		const metadata = extractMetadata($);

		// INVARIANT: Canonical extracted
		expect(metadata.canonical).toBe("https://example.com/canonical");
	});

	test("extracts robots meta", () => {
		const html = '<meta name="robots" content="noindex, nofollow">';
		const $ = cheerio.load(html);
		const metadata = extractMetadata($);

		// INVARIANT: Robots extracted
		expect(metadata.robots).toBe("noindex, nofollow");
	});

	test("extracts viewport", () => {
		const html = '<meta name="viewport" content="width=device-width">';
		const $ = cheerio.load(html);
		const metadata = extractMetadata($);

		// INVARIANT: Viewport extracted
		expect(metadata.viewport).toBe("width=device-width");
	});

	test("extracts charset", () => {
		const html = '<meta charset="UTF-8">';
		const $ = cheerio.load(html);
		const metadata = extractMetadata($);

		// INVARIANT: Charset extracted
		expect(metadata.charset).toBe("UTF-8");
	});

	test("extracts generator", () => {
		const html = '<meta name="generator" content="WordPress 5.0">';
		const $ = cheerio.load(html);
		const metadata = extractMetadata($);

		// INVARIANT: Generator extracted
		expect(metadata.generator).toBe("WordPress 5.0");
	});

	test("returns empty strings for missing metadata", () => {
		const html = "<html><body></body></html>";
		const $ = cheerio.load(html);
		const metadata = extractMetadata($);

		// INVARIANT: Empty strings for missing data
		expect(metadata.title).toBe("");
		expect(metadata.description).toBe("");
		expect(metadata.author).toBe("");
	});

	test("trims whitespace from values", () => {
		const html = "<title>  Title With Spaces  </title>";
		const $ = cheerio.load(html);
		const metadata = extractMetadata($);

		// INVARIANT: Whitespace trimmed
		expect(metadata.title).toBe("Title With Spaces");
	});

	test("trims whitespace from attribute-backed metadata", () => {
		const html = `
			<meta property="og:title" content="  OG Title  ">
			<meta name="description" content="  Page description \n">
			<meta name="author" content="  John Doe  ">
			<meta property="article:published_time" content=" 2023-01-01 ">
			<meta property="article:modified_time" content=" 2023-02-01 ">
			<link rel="canonical" href=" https://example.com/canonical ">
			<meta name="robots" content=" noindex, nofollow ">
			<meta name="viewport" content=" width=device-width ">
			<meta charset=" UTF-8 ">
			<meta name="generator" content=" WordPress 5.0 ">
		`;
		const $ = cheerio.load(html);
		const metadata = extractMetadata($);

		expect(metadata).toMatchObject({
			title: "OG Title",
			description: "Page description",
			author: "John Doe",
			publishDate: "2023-01-01",
			modifiedDate: "2023-02-01",
			canonical: "https://example.com/canonical",
			robots: "noindex, nofollow",
			viewport: "width=device-width",
			charset: "UTF-8",
			generator: "WordPress 5.0",
		});
	});
});

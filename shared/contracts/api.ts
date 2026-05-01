export const API_PATHS = {
	root: "/api",
	crawls: "/api/crawls",
	pages: "/api/pages",
	search: "/api/search",
	health: "/health",
	openapi: "/openapi",
} as const;

export const CRAWL_ROUTE_SEGMENTS = {
	collection: "/",
	resumable: "/resumable",
	byId: "/:id",
	stop: "/:id/stop",
	resume: "/:id/resume",
	export: "/:id/export",
	events: "/:id/events",
} as const;

export const PAGE_ROUTE_SEGMENTS = {
	content: "/:id/content",
} as const;

export const OPENAPI_CRAWL_EVENTS_PATH = `${API_PATHS.crawls}/{id}/events`;
export const OPENAPI_CRAWL_EXPORT_PATH = `${API_PATHS.crawls}/{id}/export`;

export const CRAWL_EXPORT_FORMAT_VALUES = ["json", "csv"] as const;
export type CrawlExportFormat = (typeof CRAWL_EXPORT_FORMAT_VALUES)[number];

function encodePathSegment(value: string | number): string {
	return encodeURIComponent(String(value));
}

export function buildCrawlEventsPath(crawlId: string): string {
	return `${API_PATHS.crawls}/${encodePathSegment(crawlId)}/events`;
}

export function buildCrawlExportPath(
	crawlId: string,
	format: CrawlExportFormat = "json",
): string {
	const query = new URLSearchParams({ format });
	return `${API_PATHS.crawls}/${encodePathSegment(crawlId)}/export?${query}`;
}

export function buildPageContentPath(pageId: number): string {
	return `${API_PATHS.pages}/${encodePathSegment(pageId)}/content`;
}

export function isApiPath(pathname: string): boolean {
	return (
		pathname === API_PATHS.root || pathname.startsWith(`${API_PATHS.root}/`)
	);
}

export function isCrawlEventsPath(pathname: string): boolean {
	const prefix = `${API_PATHS.crawls}/`;
	const suffix = CRAWL_ROUTE_SEGMENTS.events.replace("/:id", "");

	if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
		return false;
	}

	const crawlIdSegment = pathname.slice(prefix.length, -suffix.length);
	return crawlIdSegment.length > 0 && !crawlIdSegment.includes("/");
}

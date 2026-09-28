export const API_PATHS = {
	root: "/api",
	crawls: "/api/crawls",
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
	snapshot: "/:id/snapshot",
	pages: "/:id/pages",
	pageContent: "/:id/pages/:pageId/content",
	export: "/:id/export",
	events: "/:id/events",
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

export function buildCrawlExportPath(crawlId: string, format: CrawlExportFormat = "json"): string {
	const query = new URLSearchParams({ format });
	return `${API_PATHS.crawls}/${encodePathSegment(crawlId)}/export?${query}`;
}

/** Path prefixes the backend serves itself; the SPA and static files never claim them. */
export const SERVER_OWNED_PATH_PREFIXES = [
	API_PATHS.root,
	API_PATHS.health,
	API_PATHS.openapi,
] as const;

export function isServerOwnedPath(pathname: string): boolean {
	return SERVER_OWNED_PATH_PREFIXES.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	);
}

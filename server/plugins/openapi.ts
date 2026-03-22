import { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";

export function openapiPlugin() {
	return new Elysia({ name: "openapi-plugin" }).use(
		openapi({
			path: "/openapi",
			documentation: {
				info: {
					title: "MikuMikuCrawler API",
					version: "4.0.0",
					description:
						"HTTP + SSE backend for crawl execution, persistence, and search.",
				},
				tags: [
					{ name: "Crawls", description: "Crawl lifecycle control and state" },
					{ name: "Pages", description: "Stored page content access" },
					{ name: "Search", description: "Search across stored pages" },
					{ name: "Health", description: "Runtime health endpoints" },
				],
			},
		}),
	);
}

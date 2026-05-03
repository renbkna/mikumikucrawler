import { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";
import {
	API_PATHS,
	CRAWL_EXPORT_FORMAT_VALUES,
	OPENAPI_CRAWL_EVENTS_PATH,
	OPENAPI_CRAWL_EXPORT_PATH,
} from "../../shared/contracts/index.js";
import { SSE_LAST_EVENT_ID_PATTERN } from "../contracts/http.js";

export function openapiPlugin() {
	return new Elysia({ name: "openapi-plugin" }).use(
		openapi({
			path: API_PATHS.openapi,
			documentation: {
				info: {
					title: "MikuMikuCrawler API",
					version: "3.0.0",
					description:
						"HTTP + SSE backend for crawl execution, persistence, and search.",
				},
				tags: [
					{ name: "Crawls", description: "Crawl lifecycle control and state" },
					{ name: "Pages", description: "Stored page content access" },
					{ name: "Search", description: "Search across stored pages" },
					{ name: "Health", description: "Runtime health endpoints" },
				],
				paths: {
					[OPENAPI_CRAWL_EVENTS_PATH]: {
						get: {
							tags: ["Crawls"],
							summary: "Subscribe to crawl events",
							parameters: [
								{
									name: "id",
									in: "path",
									required: true,
									schema: { type: "string" },
								},
								{
									name: "Last-Event-ID",
									in: "header",
									required: false,
									schema: {
										type: "string",
										pattern: SSE_LAST_EVENT_ID_PATTERN,
									},
								},
							],
							responses: {
								"200": {
									description: "Server-sent crawl event stream",
									content: {
										"text/event-stream": {
											schema: { type: "string" },
										},
									},
								},
								"404": {
									description: "Crawl not found",
									content: {
										"application/json": {
											schema: { $ref: "#/components/schemas/ApiError" },
										},
									},
								},
								"422": {
									description: "Validation error",
									content: {
										"application/json": {
											schema: { $ref: "#/components/schemas/ApiError" },
										},
									},
								},
							},
						},
					},
					[OPENAPI_CRAWL_EXPORT_PATH]: {
						get: {
							tags: ["Crawls"],
							summary: "Export crawl pages",
							parameters: [
								{
									name: "id",
									in: "path",
									required: true,
									schema: { type: "string" },
								},
								{
									name: "format",
									in: "query",
									required: false,
									schema: {
										type: "string",
										enum: [...CRAWL_EXPORT_FORMAT_VALUES],
										default: "json",
									},
								},
							],
							responses: {
								"200": {
									description: "Exported crawl pages",
									content: {
										"application/json": {
											schema: {
												type: "array",
												items: {
													type: "object",
													additionalProperties: true,
												},
											},
										},
										"text/csv": {
											schema: { type: "string" },
										},
									},
								},
								"404": {
									description: "Crawl not found",
									content: {
										"application/json": {
											schema: { $ref: "#/components/schemas/ApiError" },
										},
									},
								},
								"422": {
									description: "Validation error",
									content: {
										"application/json": {
											schema: { $ref: "#/components/schemas/ApiError" },
										},
									},
								},
							},
						},
					},
				},
			},
		}),
	);
}

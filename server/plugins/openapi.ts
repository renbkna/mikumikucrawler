import { openapi } from "@elysia/openapi";
import type { AnyElysia } from "elysia/base";
import packageJson from "../../package.json" with { type: "json" };
import {
	API_PATHS,
	CRAWL_EXPORT_FORMAT_VALUES,
	CrawlExportSchema,
	OPENAPI_CRAWL_EVENTS_PATH,
	OPENAPI_CRAWL_EXPORT_PATH,
} from "../../shared/contracts/index.js";
import { ApiErrorSchema } from "../contracts/errors.js";

const apiErrorContent = {
	"application/json": {
		schema: ApiErrorSchema,
	},
} as const;

const SPECIFICATION_PATH = `${API_PATHS.openapi}/json`;

/** Elysia's runtime tag on its schemas; it is not a JSON Schema keyword. */
const ELYSIA_TYPE_ANNOTATION = "~elyTyp";

/** Copies a projected specification without the runtime tags the OpenAPI plugin carries over. */
export function withoutElysiaTypeAnnotations(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutElysiaTypeAnnotations);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== ELYSIA_TYPE_ANNOTATION)
			.map(([key, nested]) => [key, withoutElysiaTypeAnnotations(nested)]),
	);
}

/** Development-only API documentation: the interactive UI and the JSON specification it reads. */
export function openapiPlugin({ enabled }: { enabled: boolean }) {
	const documentation = openapi({
		enabled,
		path: API_PATHS.openapi,
		specPath: SPECIFICATION_PATH,
		provider: "scalar",
		scalar: { version: "1.62.9" },
		openapiVersion: "3.1.0",
		documentation: {
			info: {
				title: "MikuMikuCrawler API",
				version: packageJson.version,
				description: "HTTP + SSE backend for crawl execution, persistence, and search.",
			},
			tags: [
				{ name: "Crawls", description: "Crawl lifecycle control and state" },
				{ name: "Search", description: "Run-scoped search across stored pages" },
				{ name: "Health", description: "Runtime health endpoints" },
			],
			paths: {
				[OPENAPI_CRAWL_EVENTS_PATH]: {
					get: {
						tags: ["Crawls"],
						summary: "Subscribe to crawl events",
						description:
							"Delivers events published after the subscription opens. On connect or reconnect, recover earlier state from the crawl snapshot endpoint.",
						parameters: [
							{
								name: "id",
								in: "path",
								required: true,
								schema: { type: "string" },
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
							"204": {
								description: "Crawl has no live runtime; read its snapshot instead",
							},
							"404": {
								description: "Crawl not found",
								content: apiErrorContent,
							},
							"422": {
								description: "Validation error",
								content: apiErrorContent,
							},
							"429": {
								description: "SSE subscriber capacity reached",
								content: apiErrorContent,
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
										schema: { $ref: "#/components/schemas/CrawlExport" },
									},
									"text/csv": {
										schema: { type: "string" },
									},
								},
							},
							"404": {
								description: "Crawl not found",
								content: apiErrorContent,
							},
							"422": {
								description: "Validation error",
								content: apiErrorContent,
							},
						},
					},
				},
			},
		},
	});
	if (typeof documentation !== "function") return documentation;
	// The hook precedes the plugin so it wraps the specification route the plugin registers.
	return (host: AnyElysia) =>
		documentation(
			host.afterHandle(({ path, responseValue }) =>
				path === SPECIFICATION_PATH ? withoutElysiaTypeAnnotations(responseValue) : undefined,
			),
		);
}

/**
 * Schemas the documentation references by name. The host registers them as models, which
 * the OpenAPI plugin projects into `components.schemas`.
 */
export const openapiModels = { CrawlExport: CrawlExportSchema };

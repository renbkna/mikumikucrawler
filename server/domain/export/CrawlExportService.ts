import type { CrawlExportFormat } from "../../../shared/contracts/index.js";
import {
	CSV_EXPORT_PAGE_FIELDS,
	EXPORT_PAGE_FIELDS,
	type ExportPageRow,
} from "../../storage/repos/pageRepo.js";

const CSV_INJECTION_PREFIX = /^[=+\-@|\t]/;
const CSV_HEADERS = CSV_EXPORT_PAGE_FIELDS;
const encoder = new TextEncoder();

function safeExportFilename(crawlId: string, format: CrawlExportFormat): string {
	return `${crawlId.replace(/[^a-zA-Z0-9_-]/g, "_")}.${format}`;
}

function escapeCsvCell(value: string | null | undefined): string {
	const raw = value ?? "";
	const sanitized = CSV_INJECTION_PREFIX.test(raw) ? `'${raw}` : raw;
	return `"${sanitized.replaceAll('"', '""')}"`;
}

function createJsonExportStream(pages: Iterable<ExportPageRow>): ReadableStream<Uint8Array> {
	const iterator = pages[Symbol.iterator]();
	let started = false;
	let firstRow = true;
	let finished = false;

	return new ReadableStream({
		pull(controller) {
			if (!started) {
				started = true;
				controller.enqueue(encoder.encode("["));
				return;
			}
			if (finished) {
				controller.close();
				return;
			}

			const next = iterator.next();
			if (next.done) {
				finished = true;
				controller.enqueue(encoder.encode(firstRow ? "]" : "\n]"));
				return;
			}

			const projected = Object.fromEntries(
				EXPORT_PAGE_FIELDS.map((field) => [field, next.value[field]]),
			);
			controller.enqueue(encoder.encode(`${firstRow ? "\n" : ",\n"}${JSON.stringify(projected)}`));
			firstRow = false;
		},
		cancel() {
			iterator.return?.();
		},
	});
}

function createCsvExportStream(pages: Iterable<ExportPageRow>): ReadableStream<Uint8Array> {
	const iterator = pages[Symbol.iterator]();
	let wroteHeader = false;

	return new ReadableStream({
		pull(controller) {
			if (!wroteHeader) {
				wroteHeader = true;
				controller.enqueue(
					encoder.encode(CSV_HEADERS.map((cell) => escapeCsvCell(cell)).join(",")),
				);
				return;
			}

			const next = iterator.next();
			if (next.done) {
				controller.close();
				return;
			}

			const row = CSV_EXPORT_PAGE_FIELDS.map((field) => String(next.value[field] ?? ""));
			controller.enqueue(encoder.encode(`\n${row.map(escapeCsvCell).join(",")}`));
		},
		cancel() {
			iterator.return?.();
		},
	});
}

export function createCrawlExportResponse(
	crawlId: string,
	pages: Iterable<ExportPageRow>,
	format: CrawlExportFormat = "json",
): Response {
	const filename = safeExportFilename(crawlId, format);
	return new Response(
		format === "csv" ? createCsvExportStream(pages) : createJsonExportStream(pages),
		{
			headers: {
				"content-type":
					format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
				"content-disposition": `attachment; filename="${filename}"`,
				"cache-control": "no-transform",
			},
		},
	);
}

import {
	type CrawlExportFormat,
	CSV_EXPORT_PAGE_FIELDS,
	EXPORT_PAGE_FIELDS,
	type ExportPageRow,
} from "../../../shared/contracts/index.js";

const encoder = new TextEncoder();
// Bun implements ReadableStream.from(), which lib.dom does not yet declare.
const Stream = ReadableStream as typeof ReadableStream & {
	from<T>(iterable: Iterable<T>): ReadableStream<T>;
};

function safeExportFilename(crawlId: string, format: CrawlExportFormat): string {
	return `${crawlId.replace(/[^a-zA-Z0-9_-]/g, "_")}.${format}`;
}

function needsCsvInjectionPrefix(value: string): boolean {
	if (value.charCodeAt(0) === 9) return true;
	let index = 0;
	while (index < value.length && value.charCodeAt(index) <= 0x20) index += 1;
	return index < value.length && "=+-@|".includes(value[index] ?? "");
}

function escapeCsvCell(value: string | null | undefined): string {
	const raw = value ?? "";
	const sanitized = needsCsvInjectionPrefix(raw) ? `'${raw}` : raw;
	return `"${sanitized.replaceAll('"', '""')}"`;
}

function* jsonChunks(pages: Iterable<ExportPageRow>): Generator<Uint8Array> {
	yield encoder.encode("[");
	let firstRow = true;
	for (const page of pages) {
		const projected = Object.fromEntries(EXPORT_PAGE_FIELDS.map((field) => [field, page[field]]));
		yield encoder.encode(`${firstRow ? "\n" : ",\n"}${JSON.stringify(projected)}`);
		firstRow = false;
	}
	yield encoder.encode(firstRow ? "]" : "\n]");
}

function* csvChunks(pages: Iterable<ExportPageRow>): Generator<Uint8Array> {
	yield encoder.encode(CSV_EXPORT_PAGE_FIELDS.map((cell) => escapeCsvCell(cell)).join(","));
	for (const page of pages) {
		const row = CSV_EXPORT_PAGE_FIELDS.map((field) => String(page[field] ?? ""));
		yield encoder.encode(`\n${row.map(escapeCsvCell).join(",")}`);
	}
}

export function createCrawlExportResponse(
	crawlId: string,
	pages: Iterable<ExportPageRow>,
	format: CrawlExportFormat = "json",
): Response {
	const filename = safeExportFilename(crawlId, format);
	return new Response(Stream.from(format === "csv" ? csvChunks(pages) : jsonChunks(pages)), {
		headers: {
			"content-type":
				format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
			"content-disposition": `attachment; filename="${filename}"`,
			"cache-control": "no-transform",
		},
	});
}

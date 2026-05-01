import {
	CSV_EXPORT_PAGE_FIELDS,
	EXPORT_PAGE_FIELDS,
	type ExportPageRow,
} from "../../storage/repos/pageRepo.js";
import type { CrawlExportFormat } from "../../../shared/contracts/api.js";

export interface CrawlExportResult {
	body: string;
	contentType: string;
	contentDisposition: string;
	filename: string;
}

const CSV_INJECTION_PREFIX = /^[=+\-@|\t]/;
const CSV_HEADERS = CSV_EXPORT_PAGE_FIELDS;

function safeExportFilename(
	crawlId: string,
	format: CrawlExportFormat,
): string {
	return `${crawlId.replace(/[^a-zA-Z0-9_-]/g, "_")}.${format}`;
}

function escapeCsvCell(value: string | null | undefined): string {
	const raw = value ?? "";
	const sanitized = CSV_INJECTION_PREFIX.test(raw) ? `'${raw}` : raw;
	return `"${sanitized.replaceAll('"', '""')}"`;
}

export class CrawlExportService {
	exportPages(
		crawlId: string,
		pages: ExportPageRow[],
		format: CrawlExportFormat = "json",
	): CrawlExportResult {
		const filename = safeExportFilename(crawlId, format);

		if (format === "csv") {
			const rows = [
				CSV_HEADERS,
				...pages.map((page) =>
					CSV_EXPORT_PAGE_FIELDS.map((field) => String(page[field] ?? "")),
				),
			];
			return {
				body: rows
					.map((row) => row.map((cell) => escapeCsvCell(cell)).join(","))
					.join("\n"),
				contentType: "text/csv; charset=utf-8",
				contentDisposition: `attachment; filename="${filename}"`,
				filename,
			};
		}

		return {
			body: JSON.stringify(
				pages.map((page) =>
					Object.fromEntries(
						EXPORT_PAGE_FIELDS.map((field) => [field, page[field]]),
					),
				),
				null,
				2,
			),
			contentType: "application/json; charset=utf-8",
			contentDisposition: `attachment; filename="${filename}"`,
			filename,
		};
	}
}

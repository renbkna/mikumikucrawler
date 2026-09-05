import { type Static, Type } from "typebox";
import { StoredPageIdSchema } from "./schemas.js";

const NullableTextSchema = Type.Union([Type.String(), Type.Null()]);

/** Export column order is part of the JSON/CSV download contract. */
export const ExportPageRowSchema = Type.Object(
	{
		id: StoredPageIdSchema,
		url: Type.String(),
		title: NullableTextSchema,
		description: NullableTextSchema,
		contentType: NullableTextSchema,
		domain: Type.String(),
		content: NullableTextSchema,
		crawledAt: Type.String(),
	},
	{ additionalProperties: false },
);
export const CrawlExportSchema = Type.Array(ExportPageRowSchema);
export type ExportPageRow = Static<typeof ExportPageRowSchema>;

export const EXPORT_PAGE_FIELDS = Object.keys(
	ExportPageRowSchema.properties,
) as (keyof ExportPageRow)[];
export const CSV_EXPORT_PAGE_FIELDS = EXPORT_PAGE_FIELDS.filter((field) => field !== "content");

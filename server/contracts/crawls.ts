import { t } from "elysia";
import { optionalListLimitSchema } from "../../shared/contracts/http.js";
import { CrawlStatusSchema } from "../../shared/contracts/schemas.js";

export const DEFAULT_CRAWL_LIST_LIMIT = 25;

export const CrawlListQuerySchema = t.Object({
	status: t.Optional(CrawlStatusSchema),
	from: t.Optional(t.String({ format: "date-time" })),
	to: t.Optional(t.String({ format: "date-time" })),
	limit: optionalListLimitSchema(DEFAULT_CRAWL_LIST_LIMIT),
});

export const ResumableCrawlListQuerySchema = t.Object({
	limit: optionalListLimitSchema(DEFAULT_CRAWL_LIST_LIMIT),
});

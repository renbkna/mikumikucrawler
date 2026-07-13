import { t } from "elysia";
import { DEFAULT_CRAWL_LIST_LIMIT } from "../../shared/contracts/crawl.js";
import { optionalBoundedListLimitSchema } from "../../shared/contracts/http.js";
import { CrawlStatusSchema } from "../../shared/contracts/schemas.js";

export const CrawlListQuerySchema = t.Object({
	status: t.Optional(CrawlStatusSchema),
	from: t.Optional(t.String({ format: "date-time" })),
	to: t.Optional(t.String({ format: "date-time" })),
	limit: optionalBoundedListLimitSchema(DEFAULT_CRAWL_LIST_LIMIT),
});

export const ResumableCrawlListQuerySchema = t.Object({
	limit: optionalBoundedListLimitSchema(DEFAULT_CRAWL_LIST_LIMIT),
});

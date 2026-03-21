import { t } from "elysia";

export const PageContentParamsSchema = t.Object({
	id: t.Numeric(),
});

export const PageContentResponseSchema = t.Object({
	status: t.Literal("ok"),
	content: t.String(),
});

export type PageContentResponse = typeof PageContentResponseSchema.static;

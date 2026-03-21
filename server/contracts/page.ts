import { t } from "elysia";
import { PositiveIntegerIdSchema } from "./http.js";

export const PageContentParamsSchema = t.Object({
	id: PositiveIntegerIdSchema,
});

export const PageContentResponseSchema = t.Object({
	status: t.Literal("ok"),
	content: t.String(),
});

export type PageContentResponse = typeof PageContentResponseSchema.static;

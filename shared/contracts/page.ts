import { Value } from "@sinclair/typebox/value";
import { t } from "elysia";

export const PageContentResponseSchema = t.Object({
	status: t.Literal("ok"),
	content: t.Nullable(t.String()),
});

export type PageContentResponse = typeof PageContentResponseSchema.static;

export function isPageContentResponse(
	value: unknown,
): value is PageContentResponse {
	return Value.Check(PageContentResponseSchema, value);
}

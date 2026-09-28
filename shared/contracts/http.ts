import { t } from "elysia";
import type { Static } from "typebox";

export const API_LIST_LIMIT_BOUNDS = {
	min: 1,
	max: 100,
} as const;

/**
 * An optional list-size query parameter documenting `defaultValue`. Handlers fall back to
 * the same constant because the handler type cannot express the applied default.
 */
export function optionalListLimitSchema(defaultValue: number) {
	return t.Optional(
		t.Numeric({
			minimum: API_LIST_LIMIT_BOUNDS.min,
			maximum: API_LIST_LIMIT_BOUNDS.max,
			multipleOf: 1,
			default: defaultValue,
		}),
	);
}

export const DeleteCrawlResponseSchema = t.Object({
	status: t.Literal("ok"),
	outcome: t.Union([t.Literal("deleted"), t.Literal("already-absent")]),
});

export type DeleteCrawlResponse = Static<typeof DeleteCrawlResponseSchema>;

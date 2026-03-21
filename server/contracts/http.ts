import { t } from "elysia";

/**
 * Shared HTTP boundary contract:
 * - inputs: repeated API-edge primitives like page ids, list limits, and SSE resume headers
 * - invariants: ids and limits are positive integers; Last-Event-ID is a non-negative decimal sequence
 * - forbidden states: fractional ids/limits and malformed SSE replay positions
 */
export const PositiveIntegerIdSchema = t.Numeric({
	minimum: 1,
	multipleOf: 1,
});

export const BoundedListLimitSchema = t.Numeric({
	minimum: 1,
	maximum: 100,
	multipleOf: 1,
});

export const OptionalBoundedListLimitSchema = t.Optional(
	BoundedListLimitSchema,
);

export const OkResponseSchema = t.Object({
	status: t.Literal("ok"),
});

export const SseHeadersSchema = t.Object(
	{
		"last-event-id": t.Optional(
			t.String({
				pattern: "^(0|[1-9]\\d*)$",
			}),
		),
	},
	{
		additionalProperties: true,
	},
);

export const ValidationErrorDetailSchema = t.Object({
	path: t.String(),
	message: t.String(),
});

export type ValidationErrorDetail = typeof ValidationErrorDetailSchema.static;

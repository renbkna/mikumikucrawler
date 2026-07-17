import { t } from "elysia";

export const SSE_LAST_EVENT_ID_MAX = Number.MAX_SAFE_INTEGER;

/**
 * Shared HTTP boundary contract:
 * - inputs: repeated API-edge primitives like page ids, list limits, and SSE resume headers
 * - invariants: ids and limits are positive integers; Last-Event-ID is a safe non-negative sequence
 * - forbidden states: fractional ids/limits and malformed, oversized, or imprecise SSE positions
 */
export const PositiveIntegerIdSchema = t.Numeric({
	minimum: 1,
	multipleOf: 1,
});

export const OkResponseSchema = t.Object({
	status: t.Literal("ok"),
});

export const SseHeadersSchema = t.Object(
	{
		"last-event-id": t.Optional(
			t.Numeric({
				minimum: 0,
				maximum: SSE_LAST_EVENT_ID_MAX,
				multipleOf: 1,
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

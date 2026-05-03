import { t } from "elysia";

export {
	API_LIST_LIMIT_BOUNDS,
	BoundedListLimitSchema,
	OptionalBoundedListLimitSchema,
	optionalBoundedListLimitSchema,
} from "../../shared/contracts/http.js";

export const SSE_LAST_EVENT_ID_PATTERN = "^(0|[1-9]\\d*)$";

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

export const OkResponseSchema = t.Object({
	status: t.Literal("ok"),
});

export const SseHeadersSchema = t.Object(
	{
		"last-event-id": t.Optional(
			t.String({
				pattern: SSE_LAST_EVENT_ID_PATTERN,
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

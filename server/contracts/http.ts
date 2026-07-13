import { t } from "elysia";

export const SSE_LAST_EVENT_ID_PATTERN = "^(0|[1-9]\\d*)$";
export const SSE_LAST_EVENT_ID_MAX = Number.MAX_SAFE_INTEGER;
export const SSE_LAST_EVENT_ID_MAX_LENGTH = String(SSE_LAST_EVENT_ID_MAX).length;

export function parseSseLastEventId(value: string | undefined): number | null {
	if (value === undefined) {
		return 0;
	}

	if (!new RegExp(SSE_LAST_EVENT_ID_PATTERN).test(value)) {
		return null;
	}

	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

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
			t.String({
				pattern: SSE_LAST_EVENT_ID_PATTERN,
				maxLength: SSE_LAST_EVENT_ID_MAX_LENGTH,
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

import { t } from "elysia";
import type { Static } from "typebox";

/**
 * Shared HTTP boundary contract:
 * - inputs: repeated API-edge primitives like page ids
 * - invariants: ids are positive integers
 * - forbidden states: fractional or non-positive ids
 */
export const PositiveIntegerIdSchema = t.Numeric({
	minimum: 1,
	multipleOf: 1,
});

export const ValidationErrorDetailSchema = t.Object({
	path: t.String(),
	message: t.String(),
});

export type ValidationErrorDetail = Static<typeof ValidationErrorDetailSchema>;

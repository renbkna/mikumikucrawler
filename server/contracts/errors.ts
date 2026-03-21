import { t } from "elysia";

export const ApiErrorSchema = t.Object({
	error: t.String(),
	code: t.Optional(t.String()),
});

export type ApiError = typeof ApiErrorSchema.static;

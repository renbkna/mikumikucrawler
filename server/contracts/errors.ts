import { t } from "elysia";
import type { Static } from "typebox";
import { ValidationErrorDetailSchema } from "./http.js";

export const ApiErrorSchema = t.Object({
	error: t.String(),
	code: t.Optional(t.String()),
	details: t.Optional(t.Array(ValidationErrorDetailSchema)),
});

export type ApiError = Static<typeof ApiErrorSchema>;

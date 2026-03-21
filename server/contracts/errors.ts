import { t } from "elysia";
import { ValidationErrorDetailSchema } from "./http.js";

export const ApiErrorSchema = t.Object({
	error: t.String(),
	code: t.Optional(t.String()),
	details: t.Optional(t.Array(ValidationErrorDetailSchema)),
});

export type ApiError = typeof ApiErrorSchema.static;

import { t } from "elysia";

export const API_LIST_LIMIT_BOUNDS = {
	min: 1,
	max: 100,
} as const;

export const BoundedListLimitSchema = t.Numeric({
	minimum: API_LIST_LIMIT_BOUNDS.min,
	maximum: API_LIST_LIMIT_BOUNDS.max,
	multipleOf: 1,
});

export function optionalBoundedListLimitSchema(defaultValue?: number) {
	return t.Optional(
		t.Numeric({
			minimum: API_LIST_LIMIT_BOUNDS.min,
			maximum: API_LIST_LIMIT_BOUNDS.max,
			multipleOf: 1,
			...(defaultValue === undefined ? {} : { default: defaultValue }),
		}),
	);
}

export const OptionalBoundedListLimitSchema = optionalBoundedListLimitSchema();

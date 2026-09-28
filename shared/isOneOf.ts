/** Narrows `value` to a member of a constant tuple of allowed values. */
export function isOneOf<const TValues extends readonly string[]>(
	values: TValues,
	value: string,
): value is TValues[number] {
	return (values as readonly string[]).includes(value);
}

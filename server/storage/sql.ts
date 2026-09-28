/** Renders trusted string constants as a SQL text-literal list for IN (...) clauses. */
export function sqlTextList(values: readonly string[]): string {
	return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

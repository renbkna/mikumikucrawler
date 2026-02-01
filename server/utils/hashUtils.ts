/**
 * Fast content hashing using Bun's native hash function.
 * Useful for deduplication, ETags, and cache keys.
 */

/**
 * Hashes a string or buffer to a hex string.
 * Uses Bun's native xxhash64 implementation (fastest hash in Bun).
 */
export function hashContent(content: string | Buffer | ArrayBuffer): string {
	const buffer =
		typeof content === "string"
			? Buffer.from(content)
			: content instanceof ArrayBuffer
				? new Uint8Array(content)
				: content;

	return Bun.hash(buffer).toString(16);
}

/**
 * Creates a short hash suitable for cache keys.
 * Truncates to first 16 chars for readability while maintaining uniqueness.
 */
export function shortHash(content: string | Buffer | ArrayBuffer): string {
	return hashContent(content).slice(0, 16);
}

/**
 * Hashes multiple values together.
 * Useful for compound cache keys.
 */
export function hashValues(...values: (string | number | boolean)[]): string {
	const combined = values.join("|");
	return hashContent(combined);
}

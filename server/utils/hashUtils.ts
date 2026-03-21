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

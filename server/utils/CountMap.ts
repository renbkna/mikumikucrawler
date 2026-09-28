/** Non-negative counts per key; a key whose count reaches zero is removed. */
export class CountMap<K> {
	private readonly counts = new Map<K, number>();

	get(key: K): number {
		return this.counts.get(key) ?? 0;
	}

	increment(key: K, by = 1): number {
		const next = this.get(key) + by;
		this.counts.set(key, next);
		return next;
	}

	/** Returns false, changing nothing, when the key has no count to remove. */
	decrement(key: K): boolean {
		const current = this.get(key);
		if (current < 1) return false;
		if (current === 1) this.counts.delete(key);
		else this.counts.set(key, current - 1);
		return true;
	}

	clear(): void {
		this.counts.clear();
	}
}

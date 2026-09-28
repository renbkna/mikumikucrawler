/** Shares one in-flight promise per key; the key is released when that promise settles. */
export class SingleFlight<K, V> {
	private readonly inFlight = new Map<K, Promise<V>>();

	run(key: K, start: () => Promise<V>): Promise<V> {
		const existing = this.inFlight.get(key);
		if (existing !== undefined) return existing;
		const pending = start().finally(() => {
			if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
		});
		this.inFlight.set(key, pending);
		return pending;
	}

	settled(): Promise<PromiseSettledResult<V>[]> {
		return Promise.allSettled(this.inFlight.values());
	}
}

/**
 * Simple LRU (Least Recently Used) cache implementation with size limits.
 * Prevents unbounded memory growth by limiting the number of tracked items
 * and evicting least recently used entries when limit is reached.
 */
export class LRUCache<K, V> {
	private cache: Map<K, V>;
	private readonly maxSize: number;

	constructor(maxSize: number) {
		this.cache = new Map();
		this.maxSize = maxSize;
	}

	has(key: K): boolean {
		return this.cache.has(key);
	}

	get(key: K): V | undefined {
		if (!this.cache.has(key)) {
			return undefined;
		}
		const value = this.cache.get(key) as V;
		// Move to end (most recently used)
		this.cache.delete(key);
		this.cache.set(key, value);
		return value;
	}

	set(key: K, value: V): void {
		if (this.cache.has(key)) {
			this.cache.delete(key);
		} else if (this.cache.size >= this.maxSize) {
			// Evict oldest entry (first in Map)
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}
		this.cache.set(key, value);
	}

	get size(): number {
		return this.cache.size;
	}

	clear(): void {
		this.cache.clear();
	}
}

/**
 * LRU Cache with optional TTL (time-to-live) support.
 * Entries older than TTL are considered expired and treated as cache misses.
 */
export class LRUCacheWithTTL<K, V> {
	private cache: Map<K, { value: V; timestamp: number }>;
	private readonly maxSize: number;
	private readonly ttlMs: number;

	constructor(maxSize: number, ttlMs: number) {
		this.cache = new Map();
		this.maxSize = maxSize;
		this.ttlMs = ttlMs;
	}

	has(key: K): boolean {
		const entry = this.cache.get(key);
		if (!entry) return false;
		if (Date.now() - entry.timestamp > this.ttlMs) {
			this.cache.delete(key);
			return false;
		}
		return true;
	}

	get(key: K): V | undefined {
		const entry = this.cache.get(key);
		if (!entry) return undefined;

		if (Date.now() - entry.timestamp > this.ttlMs) {
			this.cache.delete(key);
			return undefined;
		}

		// Move to end (most recently used)
		this.cache.delete(key);
		this.cache.set(key, entry);
		return entry.value;
	}

	set(key: K, value: V): void {
		if (this.cache.has(key)) {
			this.cache.delete(key);
		} else if (this.cache.size >= this.maxSize) {
			// Evict oldest entry (first in Map)
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}
		this.cache.set(key, { value, timestamp: Date.now() });
	}

	/**
	 * Returns the number of entries in the cache (including any not-yet-evicted
	 * expired entries). Expired entries are removed lazily on `get`/`has` calls,
	 * so the count may be slightly over-reported — acceptable for monitoring purposes.
	 * Avoiding a full O(n) scan here keeps `size` O(1) and safe to call frequently.
	 */
	get size(): number {
		return this.cache.size;
	}

	/**
	 * Returns an iterator over the keys currently in the map.
	 * May include keys for entries that have expired but not yet been evicted.
	 * For accurate results, callers should use `get()` (which checks TTL) rather
	 * than iterating keys and accessing values directly.
	 */
	keys(): IterableIterator<K> {
		return this.cache.keys();
	}

	clear(): void {
		this.cache.clear();
	}
}

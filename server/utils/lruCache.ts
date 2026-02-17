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

	get size(): number {
		// Clean up expired entries before returning size
		const now = Date.now();
		for (const [key, entry] of this.cache) {
			if (now - entry.timestamp > this.ttlMs) {
				this.cache.delete(key);
			}
		}
		return this.cache.size;
	}

	keys(): IterableIterator<K> {
		// Clean up expired entries before returning keys
		const now = Date.now();
		for (const [key, entry] of this.cache) {
			if (now - entry.timestamp > this.ttlMs) {
				this.cache.delete(key);
			}
		}
		return this.cache.keys();
	}

	clear(): void {
		this.cache.clear();
	}
}

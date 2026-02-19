import { describe, expect, test } from "bun:test";
import { LRUCache, LRUCacheWithTTL } from "../lruCache.js";

describe("LRUCache", () => {
	describe("basic operations", () => {
		test("set and get values", () => {
			const cache = new LRUCache<string, number>(3);

			cache.set("a", 1);
			cache.set("b", 2);
			cache.set("c", 3);

			expect(cache.get("a")).toBe(1);
			expect(cache.get("b")).toBe(2);
			expect(cache.get("c")).toBe(3);
		});

		test("has returns true for existing keys", () => {
			const cache = new LRUCache<string, number>(3);

			cache.set("a", 1);

			expect(cache.has("a")).toBe(true);
			expect(cache.has("b")).toBe(false);
		});

		test("get returns undefined for missing keys", () => {
			const cache = new LRUCache<string, number>(3);

			expect(cache.get("missing")).toBeUndefined();
		});

		test("clear removes all entries", () => {
			const cache = new LRUCache<string, number>(3);

			cache.set("a", 1);
			cache.set("b", 2);
			cache.clear();

			expect(cache.size).toBe(0);
			expect(cache.has("a")).toBe(false);
			expect(cache.has("b")).toBe(false);
		});
	});

	describe("LRU eviction", () => {
		test("evicts oldest entry when capacity exceeded", () => {
			const cache = new LRUCache<string, number>(2);

			cache.set("a", 1);
			cache.set("b", 2);
			cache.set("c", 3);

			expect(cache.has("a")).toBe(false);
			expect(cache.has("b")).toBe(true);
			expect(cache.has("c")).toBe(true);
		});

		test("get updates recency", () => {
			const cache = new LRUCache<string, number>(2);

			cache.set("a", 1);
			cache.set("b", 2);

			cache.get("a");

			cache.set("c", 3);

			expect(cache.has("a")).toBe(true);
			expect(cache.has("b")).toBe(false);
			expect(cache.has("c")).toBe(true);
		});

		test("set on existing key updates value and recency", () => {
			const cache = new LRUCache<string, number>(2);

			cache.set("a", 1);
			cache.set("b", 2);
			cache.set("a", 10);

			expect(cache.get("a")).toBe(10);

			cache.set("c", 3);

			expect(cache.has("a")).toBe(true);
			expect(cache.has("b")).toBe(false);
		});
	});

	describe("size tracking", () => {
		test("tracks size correctly", () => {
			const cache = new LRUCache<string, number>(10);

			expect(cache.size).toBe(0);

			cache.set("a", 1);
			expect(cache.size).toBe(1);

			cache.set("b", 2);
			expect(cache.size).toBe(2);

			cache.set("a", 10);
			expect(cache.size).toBe(2);
		});

		test("size decreases on eviction", () => {
			const cache = new LRUCache<string, number>(2);

			cache.set("a", 1);
			cache.set("b", 2);
			cache.set("c", 3);

			expect(cache.size).toBe(2);
		});
	});

	describe("edge cases", () => {
		test("handles capacity of 1", () => {
			const cache = new LRUCache<string, number>(1);

			cache.set("a", 1);
			expect(cache.get("a")).toBe(1);

			cache.set("b", 2);
			expect(cache.has("a")).toBe(false);
			expect(cache.get("b")).toBe(2);
		});

		test("handles overwriting same key multiple times", () => {
			const cache = new LRUCache<string, number>(2);

			cache.set("a", 1);
			cache.set("a", 2);
			cache.set("a", 3);

			expect(cache.size).toBe(1);
			expect(cache.get("a")).toBe(3);
		});

		test("handles various key types", () => {
			const cache = new LRUCache<number | symbol, string>(3);
			const sym = Symbol("test");

			cache.set(1, "one");
			cache.set(2, "two");
			cache.set(sym, "symbol");

			expect(cache.get(1)).toBe("one");
			expect(cache.get(sym)).toBe("symbol");
		});
	});
});

describe("LRUCacheWithTTL", () => {
	describe("basic operations", () => {
		test("set and get values", () => {
			const cache = new LRUCacheWithTTL<string, number>(3, 10000);

			cache.set("a", 1);

			expect(cache.get("a")).toBe(1);
			expect(cache.has("a")).toBe(true);
		});

		test("returns undefined for missing keys", () => {
			const cache = new LRUCacheWithTTL<string, number>(3, 10000);

			expect(cache.get("missing")).toBeUndefined();
		});
	});

	describe("TTL expiration", () => {
		test("expires entries after TTL", async () => {
			const cache = new LRUCacheWithTTL<string, number>(3, 50);

			cache.set("a", 1);

			expect(cache.has("a")).toBe(true);

			await new Promise((resolve) => setTimeout(resolve, 60));

			expect(cache.has("a")).toBe(false);
			expect(cache.get("a")).toBeUndefined();
		});

		test("TTL is NOT refreshed on access (entry keeps original timestamp)", async () => {
			const cache = new LRUCacheWithTTL<string, number>(3, 100);

			cache.set("a", 1);

			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(cache.get("a")).toBe(1);

			await new Promise((resolve) => setTimeout(resolve, 60));

			expect(cache.has("a")).toBe(false);
		});

		test("has removes expired entries", async () => {
			const cache = new LRUCacheWithTTL<string, number>(3, 50);

			cache.set("a", 1);

			await new Promise((resolve) => setTimeout(resolve, 60));

			expect(cache.has("a")).toBe(false);

			expect(cache.get("a")).toBeUndefined();
		});
	});

	describe("LRU eviction with TTL", () => {
		test("evicts oldest when capacity exceeded (regardless of TTL)", () => {
			const cache = new LRUCacheWithTTL<string, number>(2, 10000);

			cache.set("a", 1);
			cache.set("b", 2);
			cache.set("c", 3);

			expect(cache.has("a")).toBe(false);
			expect(cache.has("b")).toBe(true);
			expect(cache.has("c")).toBe(true);
		});

		test("get updates recency", () => {
			const cache = new LRUCacheWithTTL<string, number>(2, 10000);

			cache.set("a", 1);
			cache.set("b", 2);
			cache.get("a");
			cache.set("c", 3);

			expect(cache.has("a")).toBe(true);
			expect(cache.has("b")).toBe(false);
		});
	});

	describe("size tracking", () => {
		test("size includes expired entries until accessed", async () => {
			const cache = new LRUCacheWithTTL<string, number>(3, 50);

			cache.set("a", 1);
			cache.set("b", 2);

			expect(cache.size).toBe(2);

			await new Promise((resolve) => setTimeout(resolve, 60));

			expect(cache.size).toBe(2);

			cache.has("a");
			cache.has("b");

			expect(cache.size).toBe(0);
		});
	});

	describe("keys iterator", () => {
		test("returns all keys including potentially expired", () => {
			const cache = new LRUCacheWithTTL<string, number>(3, 10000);

			cache.set("a", 1);
			cache.set("b", 2);

			const keys = [...cache.keys()];

			expect(keys).toContain("a");
			expect(keys).toContain("b");
		});
	});

	describe("clear", () => {
		test("removes all entries", () => {
			const cache = new LRUCacheWithTTL<string, number>(3, 10000);

			cache.set("a", 1);
			cache.set("b", 2);
			cache.clear();

			expect(cache.size).toBe(0);
			expect(cache.has("a")).toBe(false);
		});
	});
});

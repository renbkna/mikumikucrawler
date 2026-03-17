/**
 * Request coalescing - prevents duplicate simultaneous crawls.
 * If multiple users request the same URL, they all wait for one crawl result.
 */
import { Mutex } from "async-mutex";

class RequestCoalescer {
	private pending = new Map<string, Promise<unknown>>();
	private mutex = new Mutex();

	/**
	 * Coalesce a request. If the same URL is already being processed,
	 * returns the existing promise. Otherwise, executes the factory.
	 *
	 * Uses mutex to synchronize the check-then-act pattern, preventing
	 * race conditions where multiple concurrent requests for the same
	 * URL could result in duplicate crawls.
	 */
	async coalesce<T>(url: string, factory: () => Promise<T>): Promise<T> {
		const promise = await this.mutex.runExclusive(() => {
			const existing = this.pending.get(url);
			if (existing) {
				return existing;
			}

			const newPromise = factory().finally(() => {
				this.pending.delete(url);
			});

			this.pending.set(url, newPromise);
			return newPromise;
		});

		return promise as Promise<T>;
	}

	/**
	 * Check if a URL is currently being crawled.
	 */
	isPending(url: string): boolean {
		return this.pending.has(url);
	}

	/**
	 * Get count of pending requests.
	 */
	getPendingCount(): number {
		return this.pending.size;
	}

	/**
	 * Clear all pending requests (useful for testing).
	 */
	clear(): void {
		this.pending.clear();
	}
}

// Singleton instance
export const requestCoalescer = new RequestCoalescer();

/**
 * Helper function to coalesce a crawl request.
 */
export function coalesceCrawl<T>(
	url: string,
	factory: () => Promise<T>,
): Promise<T> {
	return requestCoalescer.coalesce(url, factory);
}

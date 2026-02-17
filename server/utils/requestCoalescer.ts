/**
 * Request coalescing - prevents duplicate simultaneous crawls.
 * If multiple users request the same URL, they all wait for one crawl result.
 */
class RequestCoalescer {
	private pending = new Map<string, Promise<unknown>>();

	/**
	 * Coalesce a request. If the same URL is already being processed,
	 * returns the existing promise. Otherwise, executes the factory.
	 *
	 * JavaScript's single-threaded event loop ensures Map operations are atomic,
	 * preventing race conditions without needing a mutex.
	 */
	async coalesce<T>(url: string, factory: () => Promise<T>): Promise<T> {
		// Check if already pending - this read is atomic
		const existing = this.pending.get(url);
		if (existing) {
			return existing as Promise<T>;
		}

		// Create the promise immediately and store it atomically
		// This prevents the race condition where two concurrent calls
		// could both pass the "existing" check before either sets the value
		const newPromise = factory().finally(() => {
			this.pending.delete(url);
		});

		// Set it in the map - this write is atomic
		this.pending.set(url, newPromise);
		return newPromise;
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

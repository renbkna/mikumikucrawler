/**
 * Request coalescing - prevents duplicate simultaneous crawls.
 * If multiple users request the same URL, they all wait for one crawl result.
 */

export class RequestCoalescer {
	private pending = new Map<string, Promise<unknown>>();

	coalesce<T>(url: string, factory: () => Promise<T>): Promise<T> {
		const existing = this.pending.get(url) as Promise<T> | undefined;
		if (existing) return existing;

		const p = factory().finally(() => this.pending.delete(url));
		this.pending.set(url, p);
		return p;
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

/**
 * Request coalescing - prevents duplicate simultaneous crawls.
 * If multiple users request the same URL, they all wait for one crawl result.
 */

interface PendingRequest {
	url: string;
	promise: Promise<unknown>;
	resolvers: Array<(value: unknown) => void>;
	rejecters: Array<(reason: unknown) => void>;
}

class RequestCoalescer {
	private pending = new Map<string, PendingRequest>();

	/**
	 * Coalesce a request. If the same URL is already being processed,
	 * returns the existing promise. Otherwise, executes the factory.
	 */
	async coalesce<T>(url: string, factory: () => Promise<T>): Promise<T> {
		// Check if there's already a pending request for this URL
		const existing = this.pending.get(url);
		if (existing) {
			// Return a promise that resolves when the existing request completes
			return new Promise((resolve, reject) => {
				existing.resolvers.push(resolve as (value: unknown) => void);
				existing.rejecters.push(reject);
			}) as Promise<T>;
		}

		// Create new request
		const resolvers: Array<(value: unknown) => void> = [];
		const rejecters: Array<(reason: unknown) => void> = [];

		const promise = factory().finally(() => {
			// Clean up when done
			this.pending.delete(url);
		});

		const pending: PendingRequest = {
			url,
			promise,
			resolvers,
			rejecters,
		};

		this.pending.set(url, pending);

		// Execute factory and notify all waiters
		promise
			.then((result) => {
				for (const resolve of resolvers) {
					resolve(result);
				}
			})
			.catch((error) => {
				for (const reject of rejecters) {
					reject(error);
				}
			});

		return promise;
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

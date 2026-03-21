import type { CrawlRuntime } from "./CrawlRuntime.js";

export class RuntimeRegistry {
	private readonly runtimes = new Map<string, CrawlRuntime>();

	get(crawlId: string): CrawlRuntime | undefined {
		return this.runtimes.get(crawlId);
	}

	set(crawlId: string, runtime: CrawlRuntime): void {
		this.runtimes.set(crawlId, runtime);
	}

	delete(crawlId: string): void {
		this.runtimes.delete(crawlId);
	}

	values(): IterableIterator<CrawlRuntime> {
		return this.runtimes.values();
	}

	size(): number {
		return this.runtimes.size;
	}
}

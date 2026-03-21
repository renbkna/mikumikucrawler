import type { Logger } from "../config/logging.js";
import type {
	CrawlCounters,
	CrawlOptions,
	CrawlStatus,
} from "../contracts/crawl.js";
import type { HttpClient, Resolver } from "../plugins/security.js";
import type { StorageRepos } from "../storage/db.js";
import { CrawlRuntime } from "./CrawlRuntime.js";
import type { EventStream } from "./EventStream.js";
import type { RuntimeRegistry } from "./RuntimeRegistry.js";

interface CreateCrawlManagerOptions {
	logger: Logger;
	repos: StorageRepos;
	eventStream: EventStream;
	registry: RuntimeRegistry;
	resolver: Resolver;
	httpClient: HttpClient;
}

export class CrawlManager {
	constructor(private readonly deps: CreateCrawlManagerOptions) {}

	private createRuntime(
		crawlId: string,
		options: CrawlOptions,
		config: {
			resume: boolean;
			initialSequence?: number;
			initialCounters?: CrawlCounters;
		} = { resume: false },
	): CrawlRuntime {
		const runtime = new CrawlRuntime({
			crawlId,
			options,
			logger: this.deps.logger,
			repos: this.deps.repos,
			eventStream: this.deps.eventStream,
			resolver: this.deps.resolver,
			httpClient: this.deps.httpClient,
			initialSequence: config.initialSequence,
			initialCounters: config.initialCounters,
			resume: config.resume,
			onSettled: () => {
				this.deps.registry.delete(crawlId);
			},
		});

		this.deps.registry.set(crawlId, runtime);
		return runtime;
	}

	create(options: CrawlOptions) {
		const crawlId = crypto.randomUUID();
		const record = this.deps.repos.crawlRuns.createRun(
			crawlId,
			options.target,
			options,
		);
		const runtime = this.createRuntime(crawlId, options);
		runtime.start();
		return record;
	}

	stop(crawlId: string) {
		const runtime = this.deps.registry.get(crawlId);
		if (!runtime) {
			return this.deps.repos.crawlRuns.getById(crawlId);
		}

		runtime.requestStop();
		return this.deps.repos.crawlRuns.getById(crawlId);
	}

	resume(crawlId: string) {
		const record = this.deps.repos.crawlRuns.getById(crawlId);
		if (!record) return null;
		if (record.status !== "interrupted") return null;
		if (this.deps.registry.get(crawlId)) return record;

		const runtime = this.createRuntime(crawlId, record.options, {
			resume: true,
			initialSequence: record.eventSequence,
			initialCounters: record.counters,
		});
		runtime.start();
		return this.deps.repos.crawlRuns.getById(crawlId);
	}

	get(crawlId: string) {
		return this.deps.repos.crawlRuns.getById(crawlId);
	}

	list(filters: {
		status?: CrawlStatus;
		from?: string;
		to?: string;
		limit?: number;
	}) {
		return this.deps.repos.crawlRuns.list(filters);
	}

	delete(crawlId: string): boolean {
		if (this.deps.registry.get(crawlId)) {
			return false;
		}

		const record = this.deps.repos.crawlRuns.getById(crawlId);
		if (!record) return false;
		this.deps.repos.crawlRuns.deleteRun(crawlId);
		return true;
	}

	async shutdownAll(): Promise<void> {
		const runtimes = [...this.deps.registry.values()];
		const interruptions: Promise<void>[] = [];
		for (const runtime of runtimes) {
			interruptions.push(runtime.interrupt("Process shutdown"));
		}

		await Promise.allSettled(interruptions);
		await Promise.allSettled(
			runtimes.map((runtime) => runtime.waitUntilSettled()),
		);
	}
}

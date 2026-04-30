import { CrawlRuntime, type CrawlRuntimeDependencies } from "./CrawlRuntime.js";
import type { RuntimeRegistry } from "./RuntimeRegistry.js";

export interface CrawlRuntimeFactoryDependencies
	extends Omit<CrawlRuntimeDependencies, "onSettled"> {
	registry: RuntimeRegistry;
	onRuntimeSettled?: (crawlId: string) => void;
}

export function createCrawlRuntime(
	deps: CrawlRuntimeFactoryDependencies,
): CrawlRuntime {
	const runtime = new CrawlRuntime({
		...deps,
		onSettled: () => {
			deps.registry.delete(deps.crawlId);
			deps.eventStream.scheduleCleanup(deps.crawlId);
			deps.onRuntimeSettled?.(deps.crawlId);
		},
	});

	deps.registry.set(deps.crawlId, runtime);
	return runtime;
}

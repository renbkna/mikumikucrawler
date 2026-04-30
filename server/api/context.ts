import type { CrawlManager } from "../runtime/CrawlManager.js";
import type { EventStream } from "../runtime/EventStream.js";
import type { RuntimeRegistry } from "../runtime/RuntimeRegistry.js";
import type { StorageRepos } from "../storage/db.js";

export interface RouteServices {
	crawlManager: CrawlManager;
	eventStream: EventStream;
	repos: StorageRepos;
	runtimeRegistry: RuntimeRegistry;
}

interface RouteContextBase {
	body: unknown;
	query: Record<string, unknown>;
	params: Record<string, string>;
	headers: Record<string, string | undefined>;
	request: Request;
	set: {
		status?: number | string;
		headers: Record<string, string>;
	};
}

export function routeServices<TExtra = object, TContext = unknown>(
	context: TContext,
): Omit<RouteContextBase, keyof TExtra> & RouteServices & TExtra {
	return context as Omit<RouteContextBase, keyof TExtra> &
		RouteServices &
		TExtra;
}

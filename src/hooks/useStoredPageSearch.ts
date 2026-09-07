import { useEffect, useRef, useState } from "react";
import type { CrawledPage } from "../../shared/contracts/index.js";
import { searchStoredPages } from "../api/search";
import type { CrawlControllerState } from "./crawlControllerState";

/** Query/crawl changes cancel requests; durable revisions coalesce behind the current request. */
export function useStoredPageSearch({
	crawlId,
	query: searchQuery,
	storedPageCount,
	runPhase,
}: {
	crawlId: string | null;
	query: string;
	storedPageCount: number;
	runPhase: CrawlControllerState["runPhase"];
}) {
	const requestPageSearchRef = useRef(() => {});
	const [pageSearch, setPageSearch] = useState<{
		pages: CrawledPage[];
		count: number;
		isLoading: boolean;
		error: string | null;
	}>({
		pages: [],
		count: 0,
		isLoading: false,
		error: null,
	});
	useEffect(() => {
		const query = searchQuery.trim();

		if (!query || !crawlId) {
			setPageSearch({ pages: [], count: 0, isLoading: false, error: null });
			return;
		}

		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let running = false;
		let queued = false;
		setPageSearch({ pages: [], count: 0, isLoading: true, error: null });

		// Keep one request in flight and coalesce page bursts into its next refresh.
		const schedule = (delay = 250) => {
			queued = true;
			if (running || timer !== undefined) return;
			timer = setTimeout(() => {
				timer = undefined;
				queued = false;
				running = true;
				setPageSearch((current) => ({ ...current, isLoading: true, error: null }));
				void searchStoredPages(crawlId, query, controller.signal)
					.then((result) => {
						if (controller.signal.aborted) return;
						if (!result.ok) {
							setPageSearch({ pages: [], count: 0, isLoading: false, error: result.error });
							return;
						}
						setPageSearch({
							pages: result.data.pages,
							count: result.data.count,
							isLoading: false,
							error: null,
						});
					})
					.catch((error: unknown) => {
						if (controller.signal.aborted) return;
						setPageSearch({
							pages: [],
							count: 0,
							isLoading: false,
							error: error instanceof Error ? error.message : "Request failed",
						});
					})
					.finally(() => {
						running = false;
						if (queued && !controller.signal.aborted) schedule();
					});
			}, delay);
		};

		requestPageSearchRef.current = schedule;
		schedule(0);
		return () => {
			requestPageSearchRef.current = () => {};
			clearTimeout(timer);
			controller.abort();
		};
	}, [crawlId, searchQuery]);

	// These durable revisions invalidate results without cancelling an in-flight search.
	// biome-ignore lint/correctness/useExhaustiveDependencies: Membership and phase are invalidation signals, not request arguments.
	useEffect(() => {
		requestPageSearchRef.current();
	}, [storedPageCount, runPhase]);

	return pageSearch;
}

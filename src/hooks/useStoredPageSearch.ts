import { useEffect, useRef, useState } from "react";
import type { SearchResult } from "../../shared/contracts/index.js";
import { getApiErrorMessage } from "../api/errors";
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
		results: SearchResult[];
		count: number;
		isLoading: boolean;
		error: string | null;
	}>({
		results: [],
		count: 0,
		isLoading: false,
		error: null,
	});
	useEffect(() => {
		const query = searchQuery.trim();

		if (!query || !crawlId) {
			setPageSearch({ results: [], count: 0, isLoading: false, error: null });
			return;
		}

		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let running = false;
		let queued = false;
		setPageSearch({ results: [], count: 0, isLoading: true, error: null });

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
							setPageSearch({ results: [], count: 0, isLoading: false, error: result.error });
							return;
						}
						setPageSearch({
							results: result.data.results,
							count: result.data.count,
							isLoading: false,
							error: null,
						});
					})
					.catch((error: unknown) => {
						if (controller.signal.aborted) return;
						setPageSearch({
							results: [],
							count: 0,
							isLoading: false,
							error: getApiErrorMessage(error),
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

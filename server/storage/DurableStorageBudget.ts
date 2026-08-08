import type { Database } from "bun:sqlite";

const DEFAULT_DURABLE_PAGE_RESERVATION_BYTES = 8 * 1024 * 1024;

export class DurableStorageCapacityError extends Error {
	constructor(
		readonly requestedBytes: number,
		readonly availableBytes: number,
	) {
		super(
			`Insufficient durable storage capacity: requested ${requestedBytes} bytes with ${Math.max(availableBytes, 0)} bytes available`,
		);
		this.name = "DurableStorageCapacityError";
	}
}

interface DurableStorageBudgetOptions {
	maxBytes: number;
	pageReservationBytes?: number;
}

interface SqlitePageMetric {
	page_count?: number;
	page_size?: number;
	freelist_count?: number;
}

function readPageMetric(
	db: Database,
	pragma: "page_count" | "page_size" | "freelist_count",
): number {
	const row = db.query(`PRAGMA ${pragma}`).get() as SqlitePageMetric | null;
	const value = row?.[pragma];
	if (!Number.isSafeInteger(value) || value === undefined || value < 0) {
		throw new Error(`SQLite returned an invalid ${pragma} value`);
	}
	return value;
}

/** Owns process-wide durable capacity reservations and terminal-run retention. */
export class DurableStorageBudget {
	private readonly protectedCrawlIds = new Set<string>();
	private readonly reservations = new Map<string, number>();
	private readonly maxBytes: number;
	private readonly pageReservationBytes: number;
	private readonly pageSize: number;

	constructor(
		private readonly db: Database,
		options: DurableStorageBudgetOptions,
	) {
		if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
			throw new Error("Durable storage maxBytes must be a positive safe integer");
		}
		const pageReservationBytes =
			options.pageReservationBytes ?? DEFAULT_DURABLE_PAGE_RESERVATION_BYTES;
		if (!Number.isSafeInteger(pageReservationBytes) || pageReservationBytes < 1) {
			throw new Error("Durable page reservation must be a positive safe integer");
		}

		this.maxBytes = options.maxBytes;
		this.pageReservationBytes = pageReservationBytes;
		this.pageSize = readPageMetric(db, "page_size");
		const currentPageCount = readPageMetric(db, "page_count");
		const configuredPageLimit = Math.max(Math.floor(this.maxBytes / this.pageSize), 1);
		const hardPageLimit = Math.max(configuredPageLimit, currentPageCount);
		db.query(`PRAGMA max_page_count = ${hardPageLimit}`).get();
	}

	private reservedBytes(excludingCrawlId?: string): number {
		let total = 0;
		for (const [crawlId, bytes] of this.reservations) {
			if (crawlId !== excludingCrawlId) total += bytes;
		}
		return total;
	}

	usedBytes(): number {
		const pageCount = readPageMetric(this.db, "page_count");
		const freePages = readPageMetric(this.db, "freelist_count");
		return Math.max(pageCount - freePages, 0) * this.pageSize;
	}

	usage(): { usedBytes: number; reservedBytes: number; maxBytes: number } {
		return {
			usedBytes: this.usedBytes(),
			reservedBytes: this.reservedBytes(),
			maxBytes: this.maxBytes,
		};
	}

	reserve(
		crawlId: string,
		request: { maxPages: number; pagesScanned: number },
		establish: () => void = () => {},
	): { reservedBytes: number; reclaimedCrawlIds: string[] } {
		if (
			!Number.isSafeInteger(request.maxPages) ||
			!Number.isSafeInteger(request.pagesScanned) ||
			request.maxPages < 0 ||
			request.pagesScanned < 0
		) {
			throw new Error("Durable storage reservation requires valid page counters");
		}
		const remainingPages = Math.max(request.maxPages - request.pagesScanned, 0);
		const requestedBytes = remainingPages * this.pageReservationBytes;
		if (!Number.isSafeInteger(requestedBytes)) {
			throw new Error("Durable storage reservation exceeds safe integer range");
		}
		const otherReservations = this.reservedBytes(crawlId);
		if (requestedBytes + otherReservations > this.maxBytes) {
			throw new DurableStorageCapacityError(
				requestedBytes,
				this.maxBytes - otherReservations - this.usedBytes(),
			);
		}

		const reclaimedCrawlIds = this.db.transaction(() => {
			const reclaimed: string[] = [];
			while (this.usedBytes() + otherReservations + requestedBytes > this.maxBytes) {
				const candidate = (
					this.db
						.query(`
						SELECT id
						FROM crawl_runs
						WHERE status IN ('completed', 'stopped', 'failed')
						  AND id <> ?
						ORDER BY COALESCE(completed_at, updated_at) ASC, updated_at ASC, id ASC
					`)
						.all(crawlId) as Array<{ id: string }>
				).find((row) => !this.protectedCrawlIds.has(row.id));
				if (!candidate) {
					throw new DurableStorageCapacityError(
						requestedBytes,
						this.maxBytes - otherReservations - this.usedBytes(),
					);
				}
				this.db.query("DELETE FROM crawl_runs WHERE id = ?").run(candidate.id);
				reclaimed.push(candidate.id);
			}
			establish();
			return reclaimed;
		})();

		this.protectedCrawlIds.add(crawlId);
		if (requestedBytes > 0) this.reservations.set(crawlId, requestedBytes);
		else this.reservations.delete(crawlId);
		return { reservedBytes: requestedBytes, reclaimedCrawlIds };
	}

	release(crawlId: string): void {
		this.protectedCrawlIds.delete(crawlId);
		this.reservations.delete(crawlId);
	}
}

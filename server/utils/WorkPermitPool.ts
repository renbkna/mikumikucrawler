export type WorkLease = () => void;
export type AcquireWork = (signal?: AbortSignal) => Promise<WorkLease>;

interface Waiter {
	grant(): void;
	reject(error: unknown): void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export class WorkPermitPool {
	private active = 0;
	private readonly waiters: Waiter[] = [];

	constructor(private readonly limit: number) {
		if (!Number.isSafeInteger(limit) || limit < 1) {
			throw new Error("Work permit limit must be a positive safe integer");
		}
	}

	acquire: AcquireWork = (signal) => {
		if (signal?.aborted) {
			return Promise.reject(signal.reason ?? new Error("Work admission aborted"));
		}

		return new Promise<WorkLease>((resolve, reject) => {
			const waiter: Waiter = {
				reject,
				grant: () => {
					if (waiter.onAbort) signal?.removeEventListener("abort", waiter.onAbort);
					this.active += 1;
					let released = false;
					resolve(() => {
						if (released) return;
						released = true;
						this.active -= 1;
						this.grantNext();
					});
				},
				...(signal ? { signal } : {}),
			};
			if (this.active < this.limit) {
				waiter.grant();
				return;
			}

			waiter.onAbort = () => {
				const index = this.waiters.indexOf(waiter);
				if (index >= 0) this.waiters.splice(index, 1);
				reject(signal?.reason ?? new Error("Work admission aborted"));
			};
			signal?.addEventListener("abort", waiter.onAbort, { once: true });
			this.waiters.push(waiter);
		});
	};

	private grantNext(): void {
		while (this.active < this.limit) {
			const waiter = this.waiters.shift();
			if (!waiter) return;
			if (waiter.signal?.aborted) {
				waiter.reject(waiter.signal.reason ?? new Error("Work admission aborted"));
				continue;
			}
			waiter.grant();
		}
	}
}

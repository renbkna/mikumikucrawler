import type {
	CrawlEventEnvelope,
	CrawlEventEnvelopeBase,
	CrawlEventMap,
	CrawlEventType,
} from "../contracts/events.js";

interface StreamState {
	sequence: number;
	history: CrawlEventEnvelope[];
	subscribers: Set<(event: CrawlEventEnvelope) => void>;
}

const MAX_HISTORY = 500;
const DEFAULT_CLEANUP_DELAY_MS = 5 * 60 * 1000;

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

export class EventStream {
	private readonly streams = new Map<string, StreamState>();
	private readonly cleanupTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();

	private cancelCleanup(crawlId: string): void {
		const timer = this.cleanupTimers.get(crawlId);
		if (!timer) {
			return;
		}

		clearTimeout(timer);
		this.cleanupTimers.delete(crawlId);
	}

	private getState(crawlId: string): StreamState {
		this.cancelCleanup(crawlId);
		const existing = this.streams.get(crawlId);
		if (existing) return existing;

		const state: StreamState = {
			sequence: 0,
			history: [],
			subscribers: new Set(),
		};

		this.streams.set(crawlId, state);
		return state;
	}

	initialize(crawlId: string, sequence = 0): void {
		this.cancelCleanup(crawlId);
		const state = this.getState(crawlId);
		state.sequence = Math.max(state.sequence, sequence);
	}

	publish<TType extends CrawlEventType>(
		crawlId: string,
		type: TType,
		payload: CrawlEventMap[TType],
	): CrawlEventEnvelopeBase<TType> {
		const state = this.getState(crawlId);
		const event: CrawlEventEnvelopeBase<TType> = {
			type,
			crawlId,
			sequence: state.sequence + 1,
			timestamp: new Date().toISOString(),
			payload: cloneValue(payload),
		};

		state.sequence = event.sequence;
		state.history.push(event as CrawlEventEnvelope);
		if (state.history.length > MAX_HISTORY) {
			state.history.splice(0, state.history.length - MAX_HISTORY);
		}

		for (const subscriber of state.subscribers) {
			subscriber(cloneValue(event as CrawlEventEnvelope));
		}

		return cloneValue(event);
	}

	subscribe(
		crawlId: string,
		onEvent: (event: CrawlEventEnvelope) => void,
		afterSequence = 0,
	): () => void {
		const state = this.getState(crawlId);
		for (const event of state.history) {
			if (event.sequence > afterSequence) {
				onEvent(cloneValue(event));
			}
		}

		state.subscribers.add(onEvent);
		return () => {
			state.subscribers.delete(onEvent);
		};
	}

	delete(crawlId: string): void {
		this.cancelCleanup(crawlId);
		this.streams.delete(crawlId);
	}

	scheduleCleanup(crawlId: string, delayMs = DEFAULT_CLEANUP_DELAY_MS): void {
		this.cancelCleanup(crawlId);
		this.cleanupTimers.set(
			crawlId,
			setTimeout(() => {
				this.cleanupTimers.delete(crawlId);
				const state = this.streams.get(crawlId);
				if (!state) {
					return;
				}

				if (state.subscribers.size > 0) {
					this.scheduleCleanup(crawlId, delayMs);
					return;
				}

				this.streams.delete(crawlId);
			}, delayMs),
		);
	}

	getCurrentSequence(crawlId: string): number {
		return this.getState(crawlId).sequence;
	}
}

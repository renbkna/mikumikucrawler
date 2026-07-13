import type {
	CrawlEventEnvelope,
	CrawlEventEnvelopeBase,
	CrawlEventMap,
	CrawlEventType,
} from "../../shared/contracts/index.js";

interface StreamState {
	sequence: number;
	history: CrawlEventEnvelope[];
	subscribers: Set<StreamSubscriber>;
}

interface StreamSubscriber {
	onEvent(event: CrawlEventEnvelope): void;
	onClose(): void;
}

const MAX_HISTORY = 500;
const DEFAULT_CLEANUP_DELAY_MS = 5 * 60 * 1000;
const MAX_SUBSCRIBERS_PER_CRAWL = 10;
const MAX_SUBSCRIBERS_TOTAL = 100;

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

export class EventStream {
	private readonly streams = new Map<string, StreamState>();
	private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private subscriberCount = 0;

	private removeSubscriber(state: StreamState, subscriber: StreamSubscriber): void {
		if (state.subscribers.delete(subscriber)) {
			this.subscriberCount -= 1;
		}
	}

	private closeSubscribers(state: StreamState): void {
		for (const subscriber of Array.from(state.subscribers)) {
			this.removeSubscriber(state, subscriber);
			try {
				subscriber.onClose();
			} catch {}
		}
	}

	private cancelCleanup(crawlId: string): void {
		const timer = this.cleanupTimers.get(crawlId);
		if (!timer) {
			return;
		}

		clearTimeout(timer);
		this.cleanupTimers.delete(crawlId);
	}

	private getState(crawlId: string, options: { cancelCleanup?: boolean } = {}): StreamState {
		if (options.cancelCleanup) {
			this.cancelCleanup(crawlId);
		}
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

	reset(crawlId: string, sequence = 0): void {
		this.cancelCleanup(crawlId);
		const state = this.getState(crawlId);
		this.closeSubscribers(state);
		state.sequence = sequence;
		state.history = [];
	}

	publish<TType extends CrawlEventType>(
		crawlId: string,
		type: TType,
		payload: CrawlEventMap[TType],
	): CrawlEventEnvelopeBase<TType> {
		const state = this.getState(crawlId, { cancelCleanup: true });
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

		for (const subscriber of Array.from(state.subscribers)) {
			try {
				subscriber.onEvent(cloneValue(event as CrawlEventEnvelope));
			} catch {
				this.removeSubscriber(state, subscriber);
				try {
					subscriber.onClose();
				} catch {}
			}
		}

		return cloneValue(event);
	}

	subscribe(
		crawlId: string,
		onEvent: (event: CrawlEventEnvelope) => void,
		afterSequence = 0,
		onClose: () => void = () => {},
	): () => void {
		const state = this.getState(crawlId);
		if (!this.hasSubscriberCapacity(crawlId)) {
			throw new Error("SSE subscriber capacity reached");
		}

		const subscriber: StreamSubscriber = { onEvent, onClose };
		state.subscribers.add(subscriber);
		this.subscriberCount += 1;
		try {
			for (const event of state.history) {
				if (event.sequence > afterSequence) {
					onEvent(cloneValue(event));
				}
			}
		} catch (error) {
			this.removeSubscriber(state, subscriber);
			throw error;
		}

		return () => {
			this.removeSubscriber(state, subscriber);
		};
	}

	hasSubscriberCapacity(crawlId: string): boolean {
		const crawlSubscriberCount = this.streams.get(crawlId)?.subscribers.size ?? 0;
		return (
			crawlSubscriberCount < MAX_SUBSCRIBERS_PER_CRAWL &&
			this.subscriberCount < MAX_SUBSCRIBERS_TOTAL
		);
	}

	delete(crawlId: string): void {
		this.cancelCleanup(crawlId);
		const state = this.streams.get(crawlId);
		if (state) {
			this.closeSubscribers(state);
		}
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

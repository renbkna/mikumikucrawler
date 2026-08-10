import type {
	CrawlEventEnvelope,
	CrawlEventEnvelopeBase,
	CrawlEventMap,
	CrawlEventType,
} from "../../shared/contracts/index.js";
import { isSettledCrawlEventType } from "../../shared/contracts/index.js";

interface StreamState {
	generation: number;
	sequence: number;
	history: Array<{ event: CrawlEventEnvelope; bytes: number }>;
	historyBytes: number;
	runtimeOwned: boolean;
	subscribers: Set<StreamSubscriber>;
}

interface StreamSubscriber {
	onEvent(event: CrawlEventEnvelope): void;
	onClose(): void;
	clientKey?: string;
}

const MAX_HISTORY = 500;
const MAX_HISTORY_BYTES_PER_CRAWL = 1024 * 1024;
const MAX_HISTORY_BYTES_TOTAL = 8 * 1024 * 1024;
const MAX_STREAM_STATES = 64;
const DEFAULT_CLEANUP_DELAY_MS = 5 * 60 * 1000;
const MAX_SUBSCRIBERS_PER_CRAWL = 10;
const MAX_SUBSCRIBERS_TOTAL = 100;
const MAX_SUBSCRIBERS_PER_CLIENT = 4;
const MAX_SUBSCRIBERS_PER_CLIENT_PER_CRAWL = 2;

export class EventStream {
	private readonly streams = new Map<string, StreamState>();
	private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly subscriberCountsByClient = new Map<string, number>();
	private subscriberCount = 0;
	private totalHistoryBytes = 0;
	private closed = false;

	private removeSubscriber(state: StreamState, subscriber: StreamSubscriber): void {
		if (state.subscribers.delete(subscriber)) {
			this.subscriberCount -= 1;
			if (subscriber.clientKey) {
				const count = (this.subscriberCountsByClient.get(subscriber.clientKey) ?? 1) - 1;
				if (count > 0) this.subscriberCountsByClient.set(subscriber.clientKey, count);
				else this.subscriberCountsByClient.delete(subscriber.clientKey);
			}
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

	private removeState(crawlId: string, state: StreamState): void {
		this.cancelCleanup(crawlId);
		this.closeSubscribers(state);
		this.totalHistoryBytes -= state.historyBytes;
		this.streams.delete(crawlId);
	}

	private makeState(crawlId: string): StreamState {
		if (this.closed) throw new Error("Event stream is closed");
		while (this.streams.size >= MAX_STREAM_STATES) {
			const candidate = Array.from(this.streams).find(([, state]) => !state.runtimeOwned);
			if (!candidate) throw new Error("SSE stream state capacity reached");
			this.removeState(candidate[0], candidate[1]);
		}
		const state: StreamState = {
			generation: 0,
			sequence: 0,
			history: [],
			historyBytes: 0,
			runtimeOwned: false,
			subscribers: new Set(),
		};
		this.streams.set(crawlId, state);
		return state;
	}

	private getState(crawlId: string, options: { cancelCleanup?: boolean } = {}): StreamState {
		if (options.cancelCleanup) {
			this.cancelCleanup(crawlId);
		}
		const existing = this.streams.get(crawlId);
		if (existing) return existing;
		return this.makeState(crawlId);
	}

	initialize(crawlId: string, sequence = 0): number {
		this.cancelCleanup(crawlId);
		const state = this.getState(crawlId);
		state.runtimeOwned = true;
		state.sequence = Math.max(state.sequence, sequence);
		return state.generation;
	}

	reset(crawlId: string, sequence = 0): number {
		this.cancelCleanup(crawlId);
		const state = this.getState(crawlId);
		this.closeSubscribers(state);
		this.totalHistoryBytes -= state.historyBytes;
		state.generation += 1;
		state.sequence = sequence;
		state.history = [];
		state.historyBytes = 0;
		state.runtimeOwned = true;
		return state.generation;
	}

	private trimHistory(state: StreamState): void {
		while (state.history.length > MAX_HISTORY || state.historyBytes > MAX_HISTORY_BYTES_PER_CRAWL) {
			const removed = state.history.shift();
			if (!removed) break;
			state.historyBytes -= removed.bytes;
			this.totalHistoryBytes -= removed.bytes;
		}
		while (this.totalHistoryBytes > MAX_HISTORY_BYTES_TOTAL) {
			const candidate =
				Array.from(this.streams.values()).find(
					(stream) => !stream.runtimeOwned && stream.history.length > 0,
				) ?? Array.from(this.streams.values()).find((stream) => stream.history.length > 0);
			const removed = candidate?.history.shift();
			if (!candidate || !removed) break;
			candidate.historyBytes -= removed.bytes;
			this.totalHistoryBytes -= removed.bytes;
		}
	}

	publish<TType extends CrawlEventType>(
		crawlId: string,
		type: TType,
		payload: CrawlEventMap[TType],
	): CrawlEventEnvelopeBase<TType> {
		const state = this.getState(crawlId, { cancelCleanup: true });
		state.runtimeOwned = true;
		const event: CrawlEventEnvelopeBase<TType> = {
			type,
			crawlId,
			sequence: state.sequence + 1,
			timestamp: new Date().toISOString(),
			payload: structuredClone(payload),
		};

		state.sequence = event.sequence;
		const retainedEvent = event as CrawlEventEnvelope;
		const bytes = new TextEncoder().encode(JSON.stringify(retainedEvent)).byteLength;
		state.history.push({ event: retainedEvent, bytes });
		state.historyBytes += bytes;
		this.totalHistoryBytes += bytes;
		this.trimHistory(state);

		for (const subscriber of Array.from(state.subscribers)) {
			try {
				subscriber.onEvent(structuredClone(event as CrawlEventEnvelope));
			} catch {
				this.removeSubscriber(state, subscriber);
				try {
					subscriber.onClose();
				} catch {}
			}
		}

		return structuredClone(event);
	}

	subscribe(
		crawlId: string,
		onEvent: (event: CrawlEventEnvelope) => void,
		afterSequence = 0,
		onClose: () => void = () => {},
		clientKey?: string,
	): () => void {
		const state = this.streams.get(crawlId);
		if (!state || this.closed) {
			queueMicrotask(onClose);
			return () => {};
		}
		if (!this.hasSubscriberCapacity(crawlId, clientKey)) {
			throw new Error("SSE subscriber capacity reached");
		}

		const subscriber: StreamSubscriber = { onEvent, onClose, ...(clientKey ? { clientKey } : {}) };
		state.subscribers.add(subscriber);
		this.subscriberCount += 1;
		if (clientKey) {
			this.subscriberCountsByClient.set(
				clientKey,
				(this.subscriberCountsByClient.get(clientKey) ?? 0) + 1,
			);
		}
		try {
			for (const { event } of state.history) {
				if (event.sequence > afterSequence) {
					onEvent(structuredClone(event));
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

	hasSubscriberCapacity(crawlId: string, clientKey?: string): boolean {
		if (this.closed) return false;
		const crawlSubscriberCount = this.streams.get(crawlId)?.subscribers.size ?? 0;
		if (
			crawlSubscriberCount < MAX_SUBSCRIBERS_PER_CRAWL &&
			this.subscriberCount < MAX_SUBSCRIBERS_TOTAL
		) {
			if (!clientKey) return true;
			const clientCrawlCount = Array.from(this.streams.get(crawlId)?.subscribers ?? []).filter(
				(subscriber) => subscriber.clientKey === clientKey,
			).length;
			return (
				(this.subscriberCountsByClient.get(clientKey) ?? 0) < MAX_SUBSCRIBERS_PER_CLIENT &&
				clientCrawlCount < MAX_SUBSCRIBERS_PER_CLIENT_PER_CRAWL
			);
		}
		return false;
	}

	hasReplayableSettledEvent(crawlId: string, afterSequence = 0): boolean {
		return (
			this.streams
				.get(crawlId)
				?.history.some(
					({ event }) => event.sequence > afterSequence && isSettledCrawlEventType(event.type),
				) ?? false
		);
	}

	delete(crawlId: string): void {
		const state = this.streams.get(crawlId);
		if (state) this.removeState(crawlId, state);
	}

	scheduleCleanup(crawlId: string, generation: number, delayMs = DEFAULT_CLEANUP_DELAY_MS): void {
		const ownedState = this.streams.get(crawlId);
		if (!ownedState || ownedState.generation !== generation) return;
		ownedState.runtimeOwned = false;
		this.cancelCleanup(crawlId);
		const timer = setTimeout(() => {
			this.cleanupTimers.delete(crawlId);
			const state = this.streams.get(crawlId);
			if (!state || state.generation !== generation) {
				return;
			}

			if (state.subscribers.size > 0) {
				this.scheduleCleanup(crawlId, generation, delayMs);
				return;
			}

			this.removeState(crawlId, state);
		}, delayMs);
		timer.unref?.();
		this.cleanupTimers.set(crawlId, timer);
	}

	getCurrentSequence(crawlId: string): number {
		return this.streams.get(crawlId)?.sequence ?? 0;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const timer of this.cleanupTimers.values()) clearTimeout(timer);
		this.cleanupTimers.clear();
		for (const state of this.streams.values()) this.closeSubscribers(state);
		this.streams.clear();
		this.subscriberCountsByClient.clear();
		this.totalHistoryBytes = 0;
	}
}

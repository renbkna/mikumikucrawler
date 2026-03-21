import type {
	CrawlEventEnvelope,
	CrawlEventType,
} from "../contracts/events.js";

interface StreamState {
	sequence: number;
	history: CrawlEventEnvelope[];
	subscribers: Set<(event: CrawlEventEnvelope) => void>;
}

const MAX_HISTORY = 500;

export class EventStream {
	private readonly streams = new Map<string, StreamState>();

	private getState(crawlId: string): StreamState {
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
		const state = this.getState(crawlId);
		state.sequence = Math.max(state.sequence, sequence);
	}

	publish(
		crawlId: string,
		type: CrawlEventType,
		payload: Record<string, unknown>,
	): CrawlEventEnvelope {
		const state = this.getState(crawlId);
		const event: CrawlEventEnvelope = {
			type,
			crawlId,
			sequence: state.sequence + 1,
			timestamp: new Date().toISOString(),
			payload,
		};

		state.sequence = event.sequence;
		state.history.push(event);
		if (state.history.length > MAX_HISTORY) {
			state.history.splice(0, state.history.length - MAX_HISTORY);
		}

		for (const subscriber of state.subscribers) {
			subscriber(event);
		}

		return event;
	}

	subscribe(
		crawlId: string,
		onEvent: (event: CrawlEventEnvelope) => void,
		afterSequence = 0,
	): () => void {
		const state = this.getState(crawlId);
		for (const event of state.history) {
			if (event.sequence > afterSequence) {
				onEvent(event);
			}
		}

		state.subscribers.add(onEvent);
		return () => {
			state.subscribers.delete(onEvent);
		};
	}

	getCurrentSequence(crawlId: string): number {
		return this.getState(crawlId).sequence;
	}
}

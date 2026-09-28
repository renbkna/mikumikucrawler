import type {
	CrawlEventEnvelope,
	CrawlEventEnvelopeBase,
	CrawlEventMap,
	CrawlEventType,
} from "../../shared/contracts/index.js";
import { CountMap } from "../utils/CountMap.js";

interface StreamSubscriber {
	onEvent(event: CrawlEventEnvelope): void;
	onClose(): void;
	clientKey?: string;
}

const MAX_SUBSCRIBERS_PER_CRAWL = 10;
const MAX_SUBSCRIBERS_TOTAL = 100;
const MAX_SUBSCRIBERS_PER_CLIENT = 4;
const MAX_SUBSCRIBERS_PER_CLIENT_PER_CRAWL = 2;

/**
 * Live fan-out of crawl events to bounded subscribers. It keeps no history: a subscriber
 * sees events published after it subscribes and recovers earlier state from the durable
 * crawl snapshot. Sequence numbers are allocated by the crawl runtime that publishes.
 */
export class EventStream {
	private readonly subscribersByCrawl = new Map<string, Set<StreamSubscriber>>();
	private readonly subscriberCountsByClient = new CountMap<string>();
	private subscriberCount = 0;
	private closed = false;

	private removeSubscriber(crawlId: string, subscriber: StreamSubscriber): void {
		const subscribers = this.subscribersByCrawl.get(crawlId);
		if (!subscribers?.delete(subscriber)) return;
		if (subscribers.size === 0) this.subscribersByCrawl.delete(crawlId);
		this.subscriberCount -= 1;
		if (subscriber.clientKey) this.subscriberCountsByClient.decrement(subscriber.clientKey);
	}

	private closeSubscriber(crawlId: string, subscriber: StreamSubscriber): void {
		this.removeSubscriber(crawlId, subscriber);
		try {
			subscriber.onClose();
		} catch {}
	}

	publish<TType extends CrawlEventType>(
		crawlId: string,
		sequence: number,
		type: TType,
		payload: CrawlEventMap[TType],
	): CrawlEventEnvelopeBase<TType> {
		const event: CrawlEventEnvelopeBase<TType> = {
			type,
			crawlId,
			sequence,
			timestamp: new Date().toISOString(),
			payload: structuredClone(payload),
		};
		for (const subscriber of Array.from(this.subscribersByCrawl.get(crawlId) ?? [])) {
			try {
				subscriber.onEvent(structuredClone(event as CrawlEventEnvelope));
			} catch {
				this.closeSubscriber(crawlId, subscriber);
			}
		}
		return event;
	}

	subscribe(
		crawlId: string,
		onEvent: (event: CrawlEventEnvelope) => void,
		onClose: () => void = () => {},
		clientKey?: string,
	): () => void {
		if (this.closed) {
			queueMicrotask(onClose);
			return () => {};
		}
		if (!this.hasSubscriberCapacity(crawlId, clientKey)) {
			throw new Error("SSE subscriber capacity reached");
		}

		const subscriber: StreamSubscriber = { onEvent, onClose, ...(clientKey ? { clientKey } : {}) };
		let subscribers = this.subscribersByCrawl.get(crawlId);
		if (!subscribers) {
			subscribers = new Set();
			this.subscribersByCrawl.set(crawlId, subscribers);
		}
		subscribers.add(subscriber);
		this.subscriberCount += 1;
		if (clientKey) this.subscriberCountsByClient.increment(clientKey);
		return () => this.removeSubscriber(crawlId, subscriber);
	}

	hasSubscriberCapacity(crawlId: string, clientKey?: string): boolean {
		if (this.closed) return false;
		const crawlSubscribers = this.subscribersByCrawl.get(crawlId);
		if (
			(crawlSubscribers?.size ?? 0) >= MAX_SUBSCRIBERS_PER_CRAWL ||
			this.subscriberCount >= MAX_SUBSCRIBERS_TOTAL
		) {
			return false;
		}
		if (!clientKey) return true;
		const clientCrawlCount = Array.from(crawlSubscribers ?? []).filter(
			(subscriber) => subscriber.clientKey === clientKey,
		).length;
		return (
			this.subscriberCountsByClient.get(clientKey) < MAX_SUBSCRIBERS_PER_CLIENT &&
			clientCrawlCount < MAX_SUBSCRIBERS_PER_CLIENT_PER_CRAWL
		);
	}

	/** Ends every subscription to a crawl whose runtime no longer publishes events. */
	closeCrawl(crawlId: string): void {
		for (const subscriber of Array.from(this.subscribersByCrawl.get(crawlId) ?? [])) {
			this.closeSubscriber(crawlId, subscriber);
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const [crawlId, subscribers] of Array.from(this.subscribersByCrawl)) {
			for (const subscriber of Array.from(subscribers)) this.closeSubscriber(crawlId, subscriber);
		}
	}
}

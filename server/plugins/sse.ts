import { type SSEPayload, sse } from "elysia";
import type { CrawlEventEnvelope } from "../../shared/contracts/index.js";
import type { EventStream } from "../runtime/EventStream.js";

const KEEPALIVE_INTERVAL_MS = 15_000;
const MAX_PENDING_EVENTS = 32;
const MAX_PENDING_BYTES = 256 * 1024;

type CrawlSsePayload = SSEPayload<CrawlEventEnvelope, CrawlEventEnvelope["type"]>;

export function createCrawlEventStream(options: {
	crawlId: string;
	eventStream: EventStream;
	afterSequence: number;
	clientKey?: string;
}) {
	let close = () => {};
	let drain = () => {};
	const stream = new ReadableStream<CrawlSsePayload>({
		start(controller) {
			let closed = false;
			let unsubscribe = () => {};
			let keepAlive: ReturnType<typeof setInterval> | null = null;
			const pending: Array<{ payload: CrawlSsePayload; bytes: number }> = [];
			let pendingBytes = 0;

			close = () => {
				if (closed) return;
				closed = true;
				if (keepAlive) {
					clearInterval(keepAlive);
				}
				pending.length = 0;
				pendingBytes = 0;
				unsubscribe();
				try {
					controller.close();
				} catch {}
			};
			drain = () => {
				while (!closed && pending.length > 0 && (controller.desiredSize ?? 1) > 0) {
					const next = pending.shift();
					if (!next) break;
					pendingBytes -= next.bytes;
					controller.enqueue(next.payload);
				}
			};
			const enqueue = (payload: CrawlSsePayload, bytes: number, optional = false) => {
				if (closed) return;
				if (!optional && bytes > MAX_PENDING_BYTES) {
					close();
					return;
				}
				if (pending.length === 0 && (controller.desiredSize ?? 1) > 0) {
					controller.enqueue(payload);
					return;
				}
				if (optional) return;
				if (pending.length >= MAX_PENDING_EVENTS || pendingBytes + bytes > MAX_PENDING_BYTES) {
					close();
					return;
				}
				pending.push({ payload, bytes });
				pendingBytes += bytes;
			};

			const write = (event: CrawlEventEnvelope) => {
				if (closed) return;
				try {
					enqueue(
						sse({
							id: event.sequence,
							event: event.type,
							data: event,
						}),
						new TextEncoder().encode(JSON.stringify(event)).byteLength,
					);
				} catch {
					close();
				}
			};

			unsubscribe = options.eventStream.subscribe(
				options.crawlId,
				write,
				options.afterSequence,
				close,
				options.clientKey,
			);
			if (closed) {
				unsubscribe();
				return;
			}
			enqueue(sse({ retry: KEEPALIVE_INTERVAL_MS }), 0, true);
			keepAlive = setInterval(() => {
				if (closed) return;
				try {
					enqueue(sse({ retry: KEEPALIVE_INTERVAL_MS }), 0, true);
				} catch {
					close();
				}
			}, KEEPALIVE_INTERVAL_MS);
			keepAlive.unref?.();
		},
		pull() {
			drain();
		},
		cancel() {
			close();
		},
	});

	// Elysia owns stream detection and wire framing. Individual payloads carry
	// their event metadata; wrapping the stream marks the response as SSE.
	return sse(stream);
}

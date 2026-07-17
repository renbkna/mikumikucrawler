import { type SSEPayload, sse } from "elysia";
import type { CrawlEventEnvelope } from "../../shared/contracts/index.js";
import type { EventStream } from "../runtime/EventStream.js";

const KEEPALIVE_INTERVAL_MS = 15_000;

type CrawlSsePayload = SSEPayload<CrawlEventEnvelope, CrawlEventEnvelope["type"]>;

export function createCrawlEventStream(options: {
	crawlId: string;
	eventStream: EventStream;
	afterSequence: number;
}) {
	let close = () => {};
	const stream = new ReadableStream<CrawlSsePayload>({
		start(controller) {
			let closed = false;
			let unsubscribe = () => {};
			let keepAlive: ReturnType<typeof setInterval> | null = null;

			close = () => {
				if (closed) return;
				closed = true;
				if (keepAlive) {
					clearInterval(keepAlive);
				}
				unsubscribe();
				try {
					controller.close();
				} catch {}
			};

			const write = (event: CrawlEventEnvelope) => {
				if (closed) return;
				try {
					controller.enqueue(
						sse({
							id: event.sequence,
							event: event.type,
							data: event,
						}),
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
			);
			controller.enqueue(sse({ retry: KEEPALIVE_INTERVAL_MS }));
			keepAlive = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(sse({ retry: KEEPALIVE_INTERVAL_MS }));
				} catch {
					close();
				}
			}, KEEPALIVE_INTERVAL_MS);
		},
		cancel() {
			close();
		},
	});

	// Elysia owns stream detection and wire framing. Individual payloads carry
	// their event metadata; wrapping the stream marks the response as SSE.
	return sse(stream);
}

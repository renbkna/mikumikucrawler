import type { CrawlEventEnvelope } from "../../shared/contracts/index.js";
import type { EventStream } from "../runtime/EventStream.js";

const encoder = new TextEncoder();
const KEEPALIVE_INTERVAL_MS = 15_000;

function serializeEvent(event: CrawlEventEnvelope): Uint8Array {
	return encoder.encode(
		`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
	);
}

export function createEventStreamResponse(options: {
	crawlId: string;
	eventStream: EventStream;
	afterSequence: number;
	requestSignal: AbortSignal;
}): Response {
	let close = () => {};
	const stream = new ReadableStream<Uint8Array>({
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
					controller.enqueue(serializeEvent(event));
				} catch {
					close();
				}
			};

			unsubscribe = options.eventStream.subscribe(
				options.crawlId,
				write,
				options.afterSequence,
			);
			keepAlive = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(": keepalive\n\n"));
				} catch {
					close();
				}
			}, KEEPALIVE_INTERVAL_MS);

			options.requestSignal.addEventListener("abort", close);
		},
		cancel() {
			// `request.signal` is not guaranteed to fire when the reader cancels.
			close();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

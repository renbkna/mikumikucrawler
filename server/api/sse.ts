import { Elysia } from "elysia";
import { CrawlIdParamsSchema } from "../contracts/crawl.js";
import { ApiErrorSchema } from "../contracts/errors.js";
import type { CrawlManager } from "../runtime/CrawlManager.js";
import type { EventStream } from "../runtime/EventStream.js";

const encoder = new TextEncoder();

function serializeEvent(
	event: Record<string, unknown> & { type: string; sequence: number },
) {
	return encoder.encode(
		`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
	);
}

export function sseApi(eventStream: EventStream, crawlManager: CrawlManager) {
	return new Elysia({ name: "sse-api", prefix: "/api/crawls" }).get(
		"/:id/events",
		({ params, request, set }) => {
			const crawl = crawlManager.get(params.id);
			if (!crawl) {
				set.status = 404;
				return { error: "Crawl not found" };
			}

			const requestedSequence = Number.parseInt(
				request.headers.get("last-event-id") ?? "0",
				10,
			);

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

					const write = (event: Parameters<typeof serializeEvent>[0]) => {
						if (closed) return;
						try {
							controller.enqueue(serializeEvent(event));
						} catch {
							close();
						}
					};

					unsubscribe = eventStream.subscribe(
						params.id,
						write,
						Number.isNaN(requestedSequence) ? 0 : requestedSequence,
					);
					keepAlive = setInterval(() => {
						if (closed) return;
						try {
							controller.enqueue(encoder.encode(": keepalive\n\n"));
						} catch {
							close();
						}
					}, 15_000);

					request.signal.addEventListener("abort", close);
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
		},
		{
			params: CrawlIdParamsSchema,
			response: {
				404: ApiErrorSchema,
			},
			detail: {
				tags: ["Crawls"],
				summary: "Subscribe to crawl events",
			},
		},
	);
}

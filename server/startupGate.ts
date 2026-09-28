import { Elysia, status } from "elysia";

interface RequestHandler {
	fetch(request: Request): Response | Promise<Response>;
}

/**
 * The listener that owns the port from process start. It answers 503 until the complete
 * application is opened, then delegates every request to it.
 */
export function createStartupGate() {
	let application: RequestHandler | undefined;
	const listener = new Elysia().all("*", ({ request }) => {
		if (!application) return status(503, { error: "Server is starting" });
		return application.fetch(request);
	});
	return {
		listener,
		open(ready: RequestHandler): void {
			application = ready;
		},
	};
}

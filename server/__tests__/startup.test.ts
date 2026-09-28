import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createServerListenOptions, MAX_API_REQUEST_BODY_BYTES } from "../config/listen.js";
import { createClientKeyResolver, createListenerTransport } from "../config/rateLimit.js";
import { createStartupGate } from "../startupGate.js";

test.serial(
	"listener serves only a startup response until the complete route tree is ready",
	async () => {
		const gate = createStartupGate();
		const instance = gate.listener.listen(createServerListenOptions(0));
		const port = instance.server?.port;
		if (port === undefined) {
			await instance.stop(true);
			throw new Error("Listener owner did not expose its assigned port");
		}

		try {
			const starting = await fetch(`http://127.0.0.1:${port}/ready`);
			expect(starting.status).toBe(503);

			const application = new Elysia().get("/ready", () => "ready");
			await application.modules;
			gate.open(application);

			const settled = await fetch(`http://127.0.0.1:${port}/ready`);
			expect(settled.status).toBe(200);
			expect(await settled.text()).toBe("ready");
		} finally {
			await instance.stop(true);
		}
	},
);

test.serial(
	"applications behind the startup gate identify clients by the listener's socket",
	async () => {
		const gate = createStartupGate();
		const resolveClientKey = createClientKeyResolver(
			false,
			createListenerTransport(() => gate.listener.server ?? undefined),
		);
		const application = new Elysia().get("/client", ({ request }) => resolveClientKey(request));
		const instance = gate.listener.listen(createServerListenOptions(0));
		const port = instance.server?.port;
		if (port === undefined) {
			await instance.stop(true);
			throw new Error("Listener owner did not expose its assigned port");
		}

		try {
			await application.modules;
			gate.open(application);
			const response = await fetch(`http://127.0.0.1:${port}/client`);
			expect(await response.text()).toBe("127.0.0.1");
		} finally {
			await instance.stop(true);
		}
	},
);

test.serial("listener rejects request bodies above the API contract before parsing", async () => {
	const app = new Elysia().post("/", () => "accepted").listen(createServerListenOptions(0));
	const port = app.server?.port;
	if (port === undefined) {
		await app.stop(true);
		throw new Error("Server did not expose its assigned port");
	}

	try {
		const response = await fetch(`http://127.0.0.1:${port}/`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: "x".repeat(MAX_API_REQUEST_BODY_BYTES + 1),
		});
		expect(response.status).toBe(413);
	} finally {
		await app.stop(true);
	}
});

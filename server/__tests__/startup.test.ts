import { expect, test } from "bun:test";
import { Elysia, status } from "elysia";
import { createServerListenOptions, MAX_API_REQUEST_BODY_BYTES } from "../config/listen.js";

test.serial(
	"listener serves only a startup response until the complete route tree is ready",
	async () => {
		const listenerOwned = Promise.withResolvers<void>();
		let releaseApplication!: () => void;
		const application = listenerOwned.promise.then(async () => {
			await new Promise<void>((resolve) => {
				releaseApplication = resolve;
			});
			return new Elysia().get("/ready", () => "ready");
		});
		let applicationApp: Awaited<typeof application> | undefined;
		const bootstrap = new Elysia().all("*", ({ request, server }) => {
			if (!applicationApp) return status(503, { error: "Server is starting" });
			return applicationApp.fetch(request, server);
		});
		const instance = bootstrap.listen(createServerListenOptions(0));
		listenerOwned.resolve();
		const port = instance.server?.port;
		if (port === undefined) {
			await instance.stop(true);
			throw new Error("Listener owner did not expose its assigned port");
		}

		try {
			const starting = await fetch(`http://127.0.0.1:${port}/ready`);
			expect(starting.status).toBe(503);

			releaseApplication();
			applicationApp = await application;
			await applicationApp.modules;

			const settled = await fetch(`http://127.0.0.1:${port}/ready`);
			expect(settled.status).toBe(200);
			expect(await settled.text()).toBe("ready");
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

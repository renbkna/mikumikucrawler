import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createServerListenOptions } from "../listen.js";

test("server listen policy gives one process exclusive ownership of its port", async () => {
	const first = new Elysia().get("/", () => "first").listen(createServerListenOptions(0));
	const port = first.server?.port;
	if (port === undefined) {
		await first.stop(true);
		throw new Error("First server did not expose its assigned port");
	}

	let stopSecond: (() => Promise<unknown>) | undefined;
	try {
		expect(() => {
			const second = new Elysia().get("/", () => "second").listen(createServerListenOptions(port));
			stopSecond = () => second.stop(true);
		}).toThrow();
	} finally {
		await stopSecond?.();
		await first.stop(true);
	}
});

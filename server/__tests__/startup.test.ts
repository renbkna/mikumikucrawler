import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createServerListenOptions } from "../config/listen.js";
import { acquireListenerAndRecover } from "../startup.js";

test("failed listener acquisition cannot mutate persisted startup state", async () => {
	const owner = new Elysia().listen(createServerListenOptions(0));
	const port = owner.server?.port;
	if (port === undefined) {
		await owner.stop(true);
		throw new Error("Listener owner did not expose its assigned port");
	}

	let recoveryCalls = 0;
	let contender: Elysia | undefined;
	try {
		expect(() =>
			acquireListenerAndRecover(
				() => {
					contender = new Elysia().listen(createServerListenOptions(port));
					return contender;
				},
				() => {
					recoveryCalls += 1;
				},
			),
		).toThrow();
		expect(recoveryCalls).toBe(0);
	} finally {
		await contender?.stop(true);
		await owner.stop(true);
	}
});

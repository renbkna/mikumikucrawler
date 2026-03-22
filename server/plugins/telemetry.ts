import { opentelemetry } from "@elysiajs/opentelemetry";
import { serverTiming } from "@elysiajs/server-timing";
import { Elysia } from "elysia";

export function telemetryPlugin() {
	return new Elysia({ name: "telemetry-plugin" })
		.use(serverTiming())
		.use(opentelemetry());
}

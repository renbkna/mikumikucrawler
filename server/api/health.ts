import { Elysia, t } from "elysia";
import type { RuntimeRegistry } from "../runtime/RuntimeRegistry.js";

export function healthApi() {
	return new Elysia({ name: "health-api" }).get(
		"/health",
		(context) => {
			const { runtimeRegistry } = context as typeof context & {
				runtimeRegistry: RuntimeRegistry;
			};
			return {
				status: "ok",
				activeCrawls: runtimeRegistry.size(),
				uptime: process.uptime(),
			};
		},
		{
			response: t.Object({
				status: t.String(),
				activeCrawls: t.Number(),
				uptime: t.Number(),
			}),
			detail: {
				tags: ["Health"],
				summary: "Process health",
			},
		},
	);
}

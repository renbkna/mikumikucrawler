import { Elysia, t } from "elysia";
import type { RuntimeRegistry } from "../runtime/RuntimeRegistry.js";

export function healthApi(runtimeRegistry: RuntimeRegistry) {
	return new Elysia({ name: "health-api" }).get(
		"/health",
		() => ({
			status: "ok",
			activeCrawls: runtimeRegistry.size(),
			uptime: process.uptime(),
		}),
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

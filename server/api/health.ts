import { Elysia, t } from "elysia";
import { routeServices } from "./context.js";

export function healthApi() {
	return new Elysia({ name: "health-api" }).get(
		"/health",
		(context) => {
			const { runtimeRegistry } = routeServices(context);
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

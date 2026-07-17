import { Elysia, t } from "elysia";
import { API_PATHS } from "../../shared/contracts/index.js";
import type { RouteServicesPlugin } from "./context.js";

export function healthApi(services: RouteServicesPlugin) {
	return new Elysia({ name: "health-api" }).use(services).get(
		API_PATHS.health,
		({ runtimeRegistry }) => ({
			status: "ok",
			activeCrawls: runtimeRegistry.size,
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

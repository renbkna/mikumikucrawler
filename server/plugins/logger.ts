import { Elysia } from "elysia";
import type { AppLogger } from "../config/logging.js";

export function loggerPlugin(logger: AppLogger) {
	return new Elysia({ name: "logger-plugin" }).decorate("logger", logger);
}

import { Elysia } from "elysia";
import type { Storage } from "../storage/db.js";

export function dbPlugin(storage: Storage) {
	return new Elysia({ name: "db-plugin" })
		.decorate("db", storage.db)
		.decorate("repos", storage.repos);
}

import { Elysia } from "elysia";
import type { StorageRepos } from "../storage/db.js";

export function dbPlugin(repos: StorageRepos) {
	return new Elysia({ name: "db-plugin" }).decorate("repos", repos);
}

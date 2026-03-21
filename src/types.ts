export * from "./types/shared.js";

// Frontend-only types
import type { Stats } from "./types/shared.js";

export interface StatsPayload extends Partial<Stats> {
	log?: string;
}

export interface Toast {
	id: number;
	type: "success" | "error" | "info" | "warning";
	message: string;
	timeout: number;
}

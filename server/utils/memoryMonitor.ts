import { config } from "../config/env.js";
import type { Logger } from "../config/logging.js";

export interface MemoryUsageMb {
	rss: number;
	heapUsed: number;
}

export interface MemoryStatus extends MemoryUsageMb {
	isLowMemory: boolean;
}

function getMemoryUsage(): MemoryUsageMb {
	const usage = process.memoryUsage();
	return {
		rss: Math.round(usage.rss / 1024 / 1024),
		heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
	};
}

export function assessMemoryStatus(usage: MemoryUsageMb, memoryThresholdMb: number): MemoryStatus {
	return {
		...usage,
		isLowMemory: usage.rss > memoryThresholdMb,
	};
}

/**
 * Logs the current memory status to the provided logger.
 */
export function logMemoryStatus(logger: Logger): MemoryStatus {
	const status = assessMemoryStatus(getMemoryUsage(), config.memoryThreshold);
	const icon = status.isLowMemory ? "⚠️" : "✅";
	const recommendation = status.isLowMemory
		? `RSS exceeds the configured ${config.memoryThreshold}MB browser threshold`
		: "Memory levels OK for dynamic crawling";
	logger.info(
		`${icon} Memory: ${status.rss}MB RSS | Heap: ${status.heapUsed}MB | ${recommendation}`,
	);
	return status;
}

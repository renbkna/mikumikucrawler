import { config } from "../config/env.js";
import type { Logger } from "../config/logging.js";

interface MemoryUsage {
	rss: number;
	heapUsed: number;
	heapTotal: number;
	external: number;
	arrayBuffers: number;
}

interface MemoryStatus extends MemoryUsage {
	isLowMemory: boolean;
	recommendation: string;
	totalEstimated: string;
	percentUsed: number;
}

function getMemoryUsage(): MemoryUsage {
	const usage = process.memoryUsage();
	return {
		rss: Math.round(usage.rss / 1024 / 1024),
		heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
		heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
		external: Math.round(usage.external / 1024 / 1024),
		arrayBuffers: Math.round((usage.arrayBuffers || 0) / 1024 / 1024),
	};
}

function isLowMemory(): boolean {
	const usage = getMemoryUsage();
	// Use configurable threshold based on environment (350MB for Render, 600MB otherwise)
	return usage.rss > config.memoryThreshold;
}

function getMemoryStatus(): MemoryStatus {
	const usage = getMemoryUsage();
	const lowMem = isLowMemory();

	return {
		...usage,
		isLowMemory: lowMem,
		recommendation: lowMem
			? "Consider upgrading to at least 1GB RAM for Playwright support"
			: "Memory levels OK for dynamic crawling",
		totalEstimated: `${usage.rss}MB total | Heap: ${usage.heapUsed}MB`,
		percentUsed: Math.round((usage.rss / 512) * 100),
	};
}

/**
 * Logs the current memory status to the provided logger.
 */
export function logMemoryStatus(logger: Logger): MemoryStatus {
	const status = getMemoryStatus();
	const icon = status.isLowMemory ? "⚠️" : "✅";
	logger.info(
		`${icon} Memory: ${status.totalEstimated} | ${status.recommendation}`,
	);
	return status;
}

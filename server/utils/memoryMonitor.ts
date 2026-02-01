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

/**
 * Retrieves the current process memory usage in Megabytes.
 */
export function getMemoryUsage(): MemoryUsage {
	const usage = process.memoryUsage();
	return {
		rss: Math.round(usage.rss / 1024 / 1024),
		heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
		heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
		external: Math.round(usage.external / 1024 / 1024),
		arrayBuffers: Math.round((usage.arrayBuffers || 0) / 1024 / 1024),
	};
}

/** Determines if the current RSS usage exceeds the safe threshold for dynamic rendering. */
export function isLowMemory(): boolean {
	const usage = getMemoryUsage();
	// Reduced threshold since we optimized database memory usage
	return usage.rss > 350;
}

/**
 * Returns a comprehensive memory status report with recommendations.
 */
export function getMemoryStatus(): MemoryStatus {
	const usage = getMemoryUsage();
	const lowMem = isLowMemory();

	return {
		...usage,
		isLowMemory: lowMem,
		recommendation: lowMem
			? "Consider upgrading to at least 1GB RAM for Puppeteer support"
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

/**
 * Gets a quick memory snapshot for debugging.
 */
export function getMemorySnapshot(): string {
	const usage = getMemoryUsage();
	return `RSS:${usage.rss}MB Heap:${usage.heapUsed}MB Ext:${usage.external}MB`;
}

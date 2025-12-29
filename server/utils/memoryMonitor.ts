import type { Logger } from "winston";

interface MemoryUsage {
	rss: number;
	heapUsed: number;
	heapTotal: number;
	external: number;
}

interface MemoryStatus extends MemoryUsage {
	isLowMemory: boolean;
	recommendation: string;
	totalEstimated: string;
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
	};
}

/** Determines if the current RSS usage exceeds the safe threshold for dynamic rendering. */
export function isLowMemory(): boolean {
	const usage = getMemoryUsage();
	return usage.rss > 400;
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
		totalEstimated: `${usage.rss}MB used of ~512MB available`,
	};
}

/**
 * Logs the current memory status to the provided logger.
 */
export function logMemoryStatus(logger: Logger): MemoryStatus {
	const status = getMemoryStatus();
	logger.info(
		`Memory Status: ${status.totalEstimated} | Heap: ${status.heapUsed}MB | ${status.recommendation}`,
	);
	return status;
}

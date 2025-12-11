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

export function getMemoryUsage(): MemoryUsage {
	const usage = process.memoryUsage();
	return {
		rss: Math.round(usage.rss / 1024 / 1024), // MB
		heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // MB
		heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // MB
		external: Math.round(usage.external / 1024 / 1024), // MB
	};
}

export function isLowMemory(): boolean {
	const usage = getMemoryUsage();
	// Consider low memory if RSS > 400MB (leaving 112MB for system)
	return usage.rss > 400;
}

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

export function logMemoryStatus(logger: Logger): MemoryStatus {
	const status = getMemoryStatus();
	logger.info(
		`Memory Status: ${status.totalEstimated} | Heap: ${status.heapUsed}MB | ${status.recommendation}`,
	);
	return status;
}

export class MemoryMonitor {
  static getMemoryUsage() {
    const usage = process.memoryUsage();
    return {
      rss: Math.round(usage.rss / 1024 / 1024), // MB
      heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // MB
      external: Math.round(usage.external / 1024 / 1024), // MB
    };
  }

  static isLowMemory() {
    const usage = this.getMemoryUsage();
    // Consider low memory if RSS > 400MB (leaving 112MB for system)
    return usage.rss > 400;
  }

  static getMemoryStatus() {
    const usage = this.getMemoryUsage();
    const isLow = this.isLowMemory();

    return {
      ...usage,
      isLowMemory: isLow,
      recommendation: isLow
        ? 'Consider upgrading to at least 1GB RAM for Puppeteer support'
        : 'Memory levels OK for dynamic crawling',
      totalEstimated: usage.rss + 'MB used of ~512MB available',
    };
  }

  static logMemoryStatus(logger) {
    const status = this.getMemoryStatus();
    logger.info(
      `Memory Status: ${status.totalEstimated} | Heap: ${status.heapUsed}MB | ${status.recommendation}`
    );
    return status;
  }
}

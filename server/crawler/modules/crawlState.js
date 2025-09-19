export class CrawlState {
  constructor(options) {
    this.options = options;
    this.startTime = Date.now();
    this.isActive = true;
    this.visited = new Set();
    this.domainDelays = new Map();
    this.stats = {
      pagesScanned: 0,
      linksFound: 0,
      totalData: 0,
      mediaFiles: 0,
      successCount: 0,
      failureCount: 0,
      skippedCount: 0,
    };
  }

  canProcessMore() {
    return this.isActive && this.stats.pagesScanned < this.options.maxPages;
  }

  stop() {
    this.isActive = false;
  }

  hasVisited(url) {
    return this.visited.has(url);
  }

  markVisited(url) {
    this.visited.add(url);
  }

  setDomainDelay(domain, delay) {
    this.domainDelays.set(domain, delay);
  }

  getDomainDelay(domain) {
    return this.domainDelays.get(domain) ?? this.options.crawlDelay;
  }

  recordSuccess(contentLength) {
    this.stats.pagesScanned += 1;
    this.stats.successCount += 1;

    if (typeof contentLength === 'number' && Number.isFinite(contentLength)) {
      this.stats.totalData += Math.floor(contentLength / 1024);
    }
  }

  recordFailure() {
    this.stats.failureCount += 1;
  }

  recordSkip() {
    this.stats.skippedCount += 1;
  }

  addLinks(count) {
    if (count > 0) {
      this.stats.linksFound += count;
    }
  }

  addMedia(count) {
    if (count > 0) {
      this.stats.mediaFiles += count;
    }
  }

  snapshotQueueMetrics(queueLength, activeCount) {
    const elapsedSeconds = Math.max(
      Math.floor((Date.now() - this.startTime) / 1000),
      0
    );
    const pagesPerSecond = elapsedSeconds
      ? Number((this.stats.pagesScanned / elapsedSeconds).toFixed(2))
      : 0;

    return {
      activeRequests: activeCount,
      queueLength,
      elapsedTime: elapsedSeconds,
      pagesPerSecond,
    };
  }

  buildFinalStats() {
    const elapsedSeconds = Math.max(
      Math.floor((Date.now() - this.startTime) / 1000),
      0
    );

    const elapsedTime = {
      hours: Math.floor(elapsedSeconds / 3600),
      minutes: Math.floor((elapsedSeconds % 3600) / 60),
      seconds: elapsedSeconds % 60,
    };

    const pagesPerSecond = elapsedSeconds
      ? Number((this.stats.pagesScanned / elapsedSeconds).toFixed(2))
      : 0;

    const successRate = this.stats.pagesScanned
      ? `${((this.stats.successCount / this.stats.pagesScanned) * 100).toFixed(1)}%`
      : '0%';

    return {
      ...this.stats,
      elapsedTime,
      pagesPerSecond: pagesPerSecond.toFixed(2),
      successRate,
    };
  }
}

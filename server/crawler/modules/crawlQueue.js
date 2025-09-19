import { URL } from "url";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CrawlQueue {
  constructor({ options, state, logger, socket, processItem, onIdle = async () => {} }) {
    this.options = options;
    this.state = state;
    this.logger = logger;
    this.socket = socket;
    this.processItem = processItem;
    this.onIdle = onIdle;

    this.queue = [];
    this.activeCount = 0;
    this.retryTimers = new Set();
    this.loopPromise = null;
  }

  enqueue(item) {
    if (this.state.hasVisited(item.url)) {
      return;
    }
    this.queue.push(item);
  }

  scheduleRetry(item, delay) {
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (!this.state.isActive) {
        return;
      }
      this.enqueue(item);
    }, delay);

    this.retryTimers.add(timer);
  }

  clearRetries() {
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
  }

  start() {
    if (!this.loopPromise) {
      this.loopPromise = this.loop();
    }
    return this.loopPromise;
  }

  async loop() {
    const domainProcessing = new Map();

    while ((this.queue.length > 0 || this.activeCount > 0) && this.state.isActive) {
      let deferredDelay = null;

      while (
        this.activeCount < this.options.maxConcurrentRequests &&
        this.queue.length > 0 &&
        this.state.isActive
      ) {
        const item = this.queue.shift();
        if (!item) {
          break;
        }

        try {
          const url = new URL(item.url);
          const domain = url.hostname;

          const nextAllowed = domainProcessing.get(domain) || 0;
          const now = Date.now();
          const domainDelay = this.state.getDomainDelay(domain);

          if (now < nextAllowed) {
            const waitTime = nextAllowed - now;
            deferredDelay =
              deferredDelay === null
                ? waitTime
                : Math.min(deferredDelay, waitTime);
            this.queue.push(item);
            if (this.queue.length === 1) {
              break;
            }
            continue;
          }

          domainProcessing.set(domain, now + domainDelay);

          this.activeCount += 1;
          Promise.resolve(this.processItem(item))
            .catch((error) => {
              this.logger.error(`Error in queue processing: ${error.message}`);
              this.state.recordFailure();
            })
            .finally(() => {
              this.activeCount = Math.max(0, this.activeCount - 1);
            });
        } catch (err) {
          this.logger.error(`Error in queue processing: ${err.message}`);
          this.state.recordFailure();
        }
      }

      if ((this.activeCount > 0 || this.queue.length > 0) && this.state.isActive) {
        const snapshot = this.state.snapshotQueueMetrics(
          this.queue.length,
          this.activeCount
        );
        this.socket.volatile.emit("queueStats", snapshot);
      }

      const sleepDuration =
        deferredDelay !== null
          ? Math.max(Math.min(deferredDelay, this.options.crawlDelay), 50)
          : 100;

      await sleep(sleepDuration);
    }

    if (this.state.isActive) {
      await this.onIdle();
    }
  }

  async awaitIdle() {
    if (this.loopPromise) {
      await this.loopPromise;
    }
  }
}

// Extended interfaces for better type safety
export interface Stats {
  pagesScanned: number;
  linksFound: number;
  totalData: number; // in KB
  mediaFiles?: number;
  successCount?: number;
  failureCount?: number;
  skippedCount?: number;
  elapsedTime?: {
    hours: number;
    minutes: number;
    seconds: number;
  };
  pagesPerSecond?: string;
  successRate?: string;
}

export interface QueueStats {
  activeRequests: number;
  queueLength: number;
  elapsedTime: number;
  pagesPerSecond: number;
}

export interface StatsPayload extends Partial<Stats> {
  log?: string;
}

export interface CrawledPage {
  url: string;
  content: string;
  title?: string;
  description?: string;
  contentType?: string;
  domain?: string;
}

// Crawl configuration options
export interface CrawlOptions {
  target: string;
  crawlMethod: string;
  crawlDepth: number;
  crawlDelay: number;
  maxPages: number;
  maxConcurrentRequests: number;
  retryLimit: number;
  dynamic: boolean;
  respectRobots: boolean;
  contentOnly: boolean;
  saveMedia: boolean;
}

// Toast notification system
export interface Toast {
  id: number;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
  timeout: number;
}

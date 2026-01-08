import type {
	CrawledPage,
	CrawlOptions,
	ExtractedLink,
	ProcessedPageData,
	QueueStats,
	Stats,
} from "./shared.js";

// Re-export shared types for convenience if needed, but prefer direct imports
export type {
	CrawlOptions,
	CrawledPage,
	Stats,
	QueueStats,
	ExtractedLink,
	ProcessedPageData,
};

// Extend CrawledPage for socket usage if it needs extra fields like 'links'
// which 'pageDetails' event seems to return.
export interface SocketCrawledPage extends CrawledPage {
	links?: ExtractedLink[];
}

/**
 * Socket events sent from the Client to the Server.
 */
export interface ClientToServerEvents {
	startAttack: (options: CrawlOptions) => void;
	stopAttack: () => void;
	getPageDetails: (url: string) => void;
	exportData: (format: string) => void;
}

/**
 * Socket events sent from the Server to the Client.
 */
export interface ServerToClientEvents {
	connect: () => void;
	disconnect: () => void;
	stats: (data: Stats & { log?: string }) => void;
	queueStats: (data: QueueStats) => void;
	pageContent: (data: CrawledPage) => void;
	exportResult: (data: { data: string; format: string }) => void;
	crawlError: (error: { message: string }) => void;
	error: (error: { message: string }) => void;
	attackEnd: (finalStats: Stats) => void;
	pageDetails: (data: SocketCrawledPage | null) => void;
	exportStart: (data: { format: string }) => void;
	exportChunk: (data: { data: string }) => void;
	exportComplete: (data: { count: number }) => void;
}

export type ExportFormat = "json" | "csv";

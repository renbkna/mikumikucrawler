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
 * Export operation tracking to prevent race conditions.
 * Root cause fix: Each export operation gets a unique request ID
 * so the client can correlate chunks with the correct export.
 */
export interface ExportStartData {
	format: string;
	requestId: string;
}

export interface ExportChunkData {
	data: string;
	requestId: string;
}

export interface ExportCompleteData {
	count: number;
	requestId: string;
}

export interface ExportErrorData {
	message: string;
	requestId?: string;
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
	crawlError: (error: { message: string; requestId?: string }) => void;
	error: (error: { message: string; requestId?: string }) => void;
	attackEnd: (finalStats: Stats) => void;
	pageDetails: (data: SocketCrawledPage | null) => void;
	// Root cause fix: Export events now include requestId to prevent race conditions
	exportStart: (data: ExportStartData) => void;
	exportChunk: (data: ExportChunkData) => void;
	exportComplete: (data: ExportCompleteData) => void;
}

export type ExportFormat = "json" | "csv";

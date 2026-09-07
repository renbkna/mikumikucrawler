export interface InitializeResult {
	dynamicEnabled: boolean;
	fallbackLog?: string;
}

interface DynamicRenderResult {
	content: string;
	effectiveUrl: string;
	statusCode: number;
	contentType: string;
	contentLength: number;
	title: string;
	description: string;
	xRobotsTag?: string | null;
	retryAfter?: string | null;
}

interface DynamicRenderConsentBlocked {
	type: "consentBlocked";
	message: string;
	statusCode: number;
}

interface DynamicRenderSuccess {
	type: "success";
	result: DynamicRenderResult;
}

interface DynamicStaticFallback {
	type: "staticFallback";
	reason: "non-html" | "renderer-unavailable" | "content-unavailable";
	targetUrl?: string;
}

interface DynamicTransportFailure {
	type: "transportFailure";
	message: string;
}

interface DynamicPolicyBlocked {
	type: "policyBlocked";
	message: string;
}

interface DynamicTooLarge {
	type: "tooLarge";
}

interface DynamicUnsupported {
	type: "unsupported";
	contentType: string;
	statusCode: number;
}

export type DynamicRenderAttempt =
	| DynamicRenderSuccess
	| DynamicRenderConsentBlocked
	| DynamicStaticFallback
	| DynamicTransportFailure
	| DynamicPolicyBlocked
	| DynamicTooLarge
	| DynamicUnsupported;

// The pipeline authorizes crawl destinations; transports invoke this capability.
export type DestinationAuthorizer = (url: string, signal?: AbortSignal) => Promise<void> | void;

export interface DocumentRenderer {
	isEnabled(): boolean;
	render(
		url: string,
		signal?: AbortSignal,
		authorizeDestination?: DestinationAuthorizer,
	): Promise<DynamicRenderAttempt>;
}

export interface CrawlRenderer extends DocumentRenderer {
	initialize(signal?: AbortSignal): Promise<InitializeResult>;
	close(): Promise<void>;
}

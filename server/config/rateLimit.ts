import net from "node:net";

const UNIDENTIFIED_CLIENT_KEY = "unidentified-client";

interface RateLimitIdentityInput {
	directAddress?: string;
	forwardedFor?: string | null;
	trustRenderProxy: boolean;
}

export function resolveRateLimitKey({
	directAddress,
	forwardedFor,
	trustRenderProxy,
}: RateLimitIdentityInput): string {
	if (trustRenderProxy) {
		const renderClientAddress = forwardedFor?.split(",", 1)[0]?.trim();
		if (renderClientAddress && net.isIP(renderClientAddress)) return renderClientAddress;
	}

	if (directAddress && net.isIP(directAddress)) return directAddress;

	// Unknown clients share one bucket, preserving the limit without making
	// socket-address discovery an application availability dependency.
	return UNIDENTIFIED_CLIENT_KEY;
}

/** How the listening server exposes a request's connection; absent outside a real listener. */
export interface RequestTransport {
	/** The socket peer address of a request the listener received. */
	peerAddress(request: Request): string | undefined;
	/** Lifts the idle timeout for a long-lived response such as an event stream. */
	keepOpen(request: Request): void;
}

export function createListenerTransport(
	server: () => Bun.Server<unknown> | undefined,
): RequestTransport {
	return {
		peerAddress: (request) => server()?.requestIP(request)?.address,
		keepOpen: (request) => server()?.timeout(request, 0),
	};
}

export type ClientKeyResolver = (request: Request) => string;

export function createClientKeyResolver(
	trustRenderProxy: boolean,
	transport: RequestTransport,
): ClientKeyResolver {
	return (request) =>
		resolveRateLimitKey({
			directAddress: transport.peerAddress(request),
			forwardedFor: request.headers.get("x-forwarded-for"),
			trustRenderProxy,
		});
}

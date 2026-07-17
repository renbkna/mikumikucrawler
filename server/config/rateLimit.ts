import net from "node:net";
import type { Generator } from "elysia-rate-limit";

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

export function createRateLimitKeyGenerator(trustRenderProxy: boolean): Generator {
	return (request, server) =>
		resolveRateLimitKey({
			directAddress: server?.requestIP(request)?.address,
			forwardedFor: request.headers.get("x-forwarded-for"),
			trustRenderProxy,
		});
}

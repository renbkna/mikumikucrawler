import dns from "node:dns";
import net from "node:net";
import { isInvalidIpAddress } from "./ipValidation.js";

/**
 * Validates that a hostname resolves only to public IPs.
 * Prevents SSRF by ensuring no internal addresses are exposed.
 */
export async function assertPublicHostname(hostname: string): Promise<void> {
	if (!hostname) {
		throw new Error("Target host is not allowed");
	}

	const normalizedHost =
		hostname.startsWith("[") && hostname.endsWith("]")
			? hostname.slice(1, -1)
			: hostname;

	const lower = normalizedHost.toLowerCase();
	if (lower === "localhost") {
		throw new Error("Target host is not allowed");
	}

	// Direct IP validation
	const ipType = net.isIP(normalizedHost);
	if (ipType) {
		if (isInvalidIpAddress(normalizedHost)) {
			throw new Error("Target host is not allowed");
		}
		return;
	}

	// Fresh DNS resolution
	let records: dns.LookupAddress[];
	try {
		records = await dns.promises.lookup(normalizedHost, {
			all: true,
			verbatim: false,
		});
	} catch {
		throw new Error("Unable to resolve target hostname");
	}

	if (!records?.length) {
		throw new Error("Unable to resolve target hostname");
	}

	const hasInvalidRecord = records.some(({ address }) =>
		isInvalidIpAddress(address),
	);

	if (hasInvalidRecord) {
		throw new Error("Target host is not allowed");
	}
}

/**
 * Validates raw crawl options.
 * This is a placeholder for more complex validation logic.
 */
export function validateCrawlOptions(options: unknown): boolean {
	if (!options || typeof options !== "object") {
		return false;
	}
	// Add more validation logic as needed
	return true;
}

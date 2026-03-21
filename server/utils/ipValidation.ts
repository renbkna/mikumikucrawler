import ipaddr from "ipaddr.js";

const ALLOWED_IP_RANGES = new Set(["unicast", "global"]);

/**
 * Validates that an IP address is not in a private/reserved range.
 * Returns true if the IP is invalid or in a disallowed range.
 */
export function isInvalidIpAddress(address: string): boolean {
	let parsed: ipaddr.IPv4 | ipaddr.IPv6;
	try {
		parsed = ipaddr.parse(address);
	} catch {
		return true;
	}

	if (
		parsed.kind() === "ipv6" &&
		(parsed as ipaddr.IPv6).isIPv4MappedAddress()
	) {
		parsed = (parsed as ipaddr.IPv6).toIPv4Address();
	}

	const range = parsed.range();
	return !ALLOWED_IP_RANGES.has(range);
}

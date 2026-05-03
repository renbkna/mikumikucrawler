import ipaddr from "ipaddr.js";

const PUBLIC_IP_RANGES = new Set(["unicast", "global"]);

function normalizeIpLiteral(address: string): string {
	return address.startsWith("[") && address.endsWith("]")
		? address.slice(1, -1)
		: address;
}

export function isPublicIpAddressLiteral(address: string): boolean {
	try {
		let parsed: ipaddr.IPv4 | ipaddr.IPv6 = ipaddr.parse(
			normalizeIpLiteral(address),
		);
		if (
			parsed.kind() === "ipv6" &&
			(parsed as ipaddr.IPv6).isIPv4MappedAddress()
		) {
			parsed = (parsed as ipaddr.IPv6).toIPv4Address();
		}
		return PUBLIC_IP_RANGES.has(parsed.range());
	} catch {
		return false;
	}
}

export function isPrivateOrReservedIpAddressLiteral(address: string): boolean {
	try {
		ipaddr.parse(normalizeIpLiteral(address));
	} catch {
		return false;
	}
	return !isPublicIpAddressLiteral(address);
}

import ipaddr from "ipaddr.js";

/** Removes the brackets URL syntax puts around IPv6 literals. */
export function unbracketIpLiteral(address: string): string {
	return address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
}

function parseIpLiteral(address: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
	const literal = unbracketIpLiteral(address);
	// process() unwraps IPv4-mapped IPv6 so the IPv4 range policy applies to it.
	return ipaddr.isValid(literal) ? ipaddr.process(literal) : null;
}

export function isPublicIpAddressLiteral(address: string): boolean {
	return parseIpLiteral(address)?.range() === "unicast";
}

export function isPrivateOrReservedIpAddressLiteral(address: string): boolean {
	const parsed = parseIpLiteral(address);
	return parsed !== null && parsed.range() !== "unicast";
}

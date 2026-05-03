import net from "node:net";
import { isPrivateOrReservedIpAddressLiteral } from "../../shared/ipPolicy.js";

/**
 * Validates that an IP address is not in a private/reserved range.
 * Returns true if the IP is invalid or in a disallowed range.
 */
export function isInvalidIpAddress(address: string): boolean {
	if (net.isIP(address) === 0) {
		return true;
	}
	return isPrivateOrReservedIpAddressLiteral(address);
}

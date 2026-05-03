import { isPrivateOrReservedIpAddressLiteral } from "../../shared/ipPolicy.js";

/**
 * Validates that an IP address is not in a private/reserved range.
 * Returns true if the IP is invalid or in a disallowed range.
 */
export function isInvalidIpAddress(address: string): boolean {
	return isPrivateOrReservedIpAddressLiteral(address);
}

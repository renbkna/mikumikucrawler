const RATE_LIMIT_STATUS_CODES = new Set([429, 503]);
const ACCESS_BLOCKED_STATUS_CODES = new Set([401, 403]);
const PERMANENT_FETCH_FAILURE_STATUS_CODES = new Set([404, 410, 501]);
const ROBOTS_NO_RULES_STATUS_CODES = new Set([401, 403, 404, 410]);

export function isRateLimitedStatus(statusCode: number): boolean {
	return RATE_LIMIT_STATUS_CODES.has(statusCode);
}

export function isAccessBlockedStatus(statusCode: number): boolean {
	return ACCESS_BLOCKED_STATUS_CODES.has(statusCode);
}

export function isPermanentFetchFailureStatus(statusCode: number): boolean {
	return PERMANENT_FETCH_FAILURE_STATUS_CODES.has(statusCode);
}

export function shouldAdaptDomainDelay(statusCode: number): boolean {
	return isRateLimitedStatus(statusCode) || statusCode === 403;
}

export function shouldTreatRobotsResponseAsNoRules(
	statusCode: number,
): boolean {
	return ROBOTS_NO_RULES_STATUS_CODES.has(statusCode);
}

import { getApiErrorMessage } from "./errors";

export interface ApiSuccess<T> {
	ok: true;
	data: T;
}

export interface ApiFailure {
	ok: false;
	error: string;
	/** HTTP status of a rejected response; absent for transport and client-side contract failures. */
	status?: number;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

interface TreatyResponseLike {
	data: unknown;
	error: { status: unknown; value: unknown } | null;
}

interface ResponseContract<T> {
	isValid(value: unknown): value is T;
	invalidMessage: string;
	failureMessage?: string;
	/** Rejects a valid payload that answers a different request than the one sent. */
	identity?: { matches(data: T): boolean; message: string };
}

/** Converts one Eden response into a validated result, forwarding the HTTP status of every rejection. */
export function unwrapApiResponse<T>(
	response: TreatyResponseLike,
	contract: ResponseContract<T>,
): ApiResult<T> {
	if (response.error || !response.data) {
		const status = response.error?.status;
		return {
			ok: false,
			error: getApiErrorMessage(response.error?.value, contract.failureMessage),
			...(typeof status === "number" ? { status } : {}),
		};
	}
	if (!contract.isValid(response.data)) {
		return { ok: false, error: contract.invalidMessage };
	}
	if (contract.identity && !contract.identity.matches(response.data)) {
		return { ok: false, error: contract.identity.message };
	}
	return { ok: true, data: response.data };
}

export function mapApiResult<T, U>(result: ApiResult<T>, map: (data: T) => U): ApiResult<U> {
	return result.ok ? { ok: true, data: map(result.data) } : result;
}

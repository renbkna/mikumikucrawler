export interface ApiSuccess<T> {
	ok: true;
	data: T;
}

export interface ApiFailure {
	ok: false;
	error: string;
	status?: number;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

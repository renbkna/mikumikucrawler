export interface ApiSuccess<T> {
	ok: true;
	data: T;
}

export interface ApiFailure {
	ok: false;
	error: string;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

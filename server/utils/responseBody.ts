import { abortError, raceAbort } from "./abort.js";

const readAbortError = (signal: AbortSignal) => abortError(signal, "Response body read aborted");

export type LimitedResponseBody = { type: "body"; bytes: Uint8Array } | { type: "tooLarge" };

export async function disposeResponseBody(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => undefined);
}

function parseContentLength(value: string | null): number | null {
	if (!value || !/^\d+$/.test(value.trim())) return null;
	return Number.parseInt(value, 10);
}

export async function readLimitedResponseBody(
	response: Response,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<LimitedResponseBody> {
	if (signal?.aborted) {
		await disposeResponseBody(response);
		signal.throwIfAborted();
	}
	const declaredLength = parseContentLength(response.headers.get("content-length"));
	if (declaredLength !== null && declaredLength > maxBytes) {
		await disposeResponseBody(response);
		return { type: "tooLarge" };
	}

	const reader = response.body?.getReader();
	if (!reader) {
		return { type: "body", bytes: new Uint8Array() };
	}

	const chunks: Uint8Array[] = [];
	let totalLength = 0;
	try {
		for (;;) {
			const { done, value } = await raceAbort(reader.read(), signal, readAbortError);
			if (done) break;
			if (!value) continue;

			totalLength += value.byteLength;
			if (totalLength > maxBytes) {
				await reader.cancel().catch(() => undefined);
				return { type: "tooLarge" };
			}
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	}

	return {
		type: "body",
		bytes: Buffer.concat(chunks, totalLength),
	};
}

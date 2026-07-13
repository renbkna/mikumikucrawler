export type LimitedResponseBody =
	| { type: "body"; bytes: Uint8Array; contentLength: number }
	| { type: "tooLarge" };

export async function disposeResponseBody(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => undefined);
}

function parseContentLength(value: string | null): number | null {
	if (!value || !/^\d+$/.test(value.trim())) return null;
	return Number.parseInt(value, 10);
}

function concatChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
	const bytes = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export async function readLimitedResponseBody(
	response: Response,
	maxBytes: number,
): Promise<LimitedResponseBody> {
	const declaredLength = parseContentLength(response.headers.get("content-length"));
	if (declaredLength !== null && declaredLength > maxBytes) {
		await disposeResponseBody(response);
		return { type: "tooLarge" };
	}

	const reader = response.body?.getReader();
	if (!reader) {
		return { type: "body", bytes: new Uint8Array(), contentLength: 0 };
	}

	const chunks: Uint8Array[] = [];
	let totalLength = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
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
		bytes: concatChunks(chunks, totalLength),
		contentLength: totalLength,
	};
}

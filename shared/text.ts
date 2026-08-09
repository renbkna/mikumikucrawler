const encoder = new TextEncoder();

export function truncateUtf8Text(value: string, maximumBytes: number): string {
	const bytes = encoder.encode(value);
	if (bytes.byteLength <= maximumBytes) return value;

	let end = maximumBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	return new TextDecoder().decode(bytes.subarray(0, end));
}

export function bytesToKilobytes(bytes: number): number {
	if (!Number.isSafeInteger(bytes) || bytes < 0) {
		throw new Error("Byte count must be a non-negative safe integer");
	}
	return bytes / 1024;
}

export function kilobytesToBytes(kilobytes: number): number {
	const bytes = Math.round(kilobytes * 1024);
	if (!Number.isFinite(kilobytes) || kilobytes < 0 || !Number.isSafeInteger(bytes)) {
		throw new Error("Kilobyte count must represent a non-negative safe byte count");
	}
	return bytes;
}

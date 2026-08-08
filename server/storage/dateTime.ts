const STORAGE_DATE_TIME_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})(?:T| )(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * Canonicalizes SQLite and RFC 3339 date-times without accepting calendar
 * normalization such as February 30. Zone-less SQLite values are UTC.
 */
export function canonicalizeStorageDateTime(value: string): string | null {
	const match = STORAGE_DATE_TIME_PATTERN.exec(value.trim());
	if (!match) return null;

	const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		return null;
	}
	if (zone && zone !== "Z") {
		const [offsetHour, offsetMinute] = zone.slice(1).split(":").map(Number);
		if (offsetHour > 23 || offsetMinute > 59) return null;
	}

	const trimmed = value.trim();
	const withIsoSeparator = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
	const candidate = zone ? withIsoSeparator : `${withIsoSeparator}Z`;
	const timestamp = Date.parse(candidate);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

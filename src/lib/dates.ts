/**
 * Dates in the UI, always in English and in the design's style, whatever the
 * browser locale is ("Today, 10:42", "Nov 15", "Mon, 16 Nov 2026, 13:11").
 *
 * Built by hand rather than with `toLocale*`: the output must not depend on the
 * viewer's locale, and the server render and the hydrated client must agree.
 * Times are 24-hour, in the viewer's time zone.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

function parse(value: string | number | Date | null | undefined): Date | null {
	if (value === null || value === undefined || value === "") return null;
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime()) ? null : d;
}

function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

function sameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

function isYesterday(d: Date, now: Date): boolean {
	const y = new Date(now);
	y.setDate(now.getDate() - 1);
	return sameDay(d, y);
}

/** "13:11" */
export function formatTime(value: string | number | Date | null | undefined): string {
	const d = parse(value);
	return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
}

/**
 * Compact stamp for list rows: "10:42" today, "Yesterday", "Nov 15" this
 * year, "Nov 15, 2025" before.
 */
export function formatListDate(
	value: string | number | Date | null | undefined,
	now: Date = new Date(),
): string {
	const d = parse(value);
	if (!d) return "";
	if (sameDay(d, now)) return formatTime(d);
	if (isYesterday(d, now)) return "Yesterday";
	const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
	return d.getFullYear() === now.getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}

/**
 * Day plus time for a message header: "Today, 10:42", "Yesterday, 18:03",
 * "Nov 15, 09:20", "Nov 15, 2025, 09:20".
 */
export function formatDayTime(
	value: string | number | Date | null | undefined,
	now: Date = new Date(),
): string {
	const d = parse(value);
	if (!d) return "";
	const time = formatTime(d);
	if (sameDay(d, now)) return `Today, ${time}`;
	if (isYesterday(d, now)) return `Yesterday, ${time}`;
	const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
	return d.getFullYear() === now.getFullYear()
		? `${md}, ${time}`
		: `${md}, ${d.getFullYear()}, ${time}`;
}

/** Full stamp (tooltips, details): "Mon, 16 Nov 2026, 13:11". */
export function formatFullDate(value: string | number | Date | null | undefined): string {
	const d = parse(value);
	if (!d) return "";
	return `${WEEKDAYS[d.getDay()]}, ${formatDay(d)}, ${formatTime(d)}`;
}

/** A day without time: "16 Nov 2026". */
export function formatDay(value: string | number | Date | null | undefined): string {
	const d = parse(value);
	if (!d) return "";
	return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

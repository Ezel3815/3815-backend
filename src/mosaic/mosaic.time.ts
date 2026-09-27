/**
 * Timezone helpers built on Intl only (no dependency, no MySQL tz tables).
 * A "local date" is a 'YYYY-MM-DD' string in a given IANA zone. Timestamps stay UTC;
 * these functions only translate between instants and the user's calendar days,
 * including 23h / 25h days around DST changes.
 */

export function isValidTimezone(tz: unknown): tz is string {
    if (typeof tz !== "string" || tz.length < 1 || tz.length > 64) return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
    let f = fmtCache.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat("en-CA", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        });
        fmtCache.set(tz, f);
    }
    return f;
}

/** Local calendar date of an instant, e.g. '2026-03-08'. */
export function localDateString(instant: Date, tz: string): string {
    const parts = fmt(tz).formatToParts(instant);
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(date: string, n: number): string {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Whole calendar days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
    const p = (s: string) => {
        const [y, m, d] = s.split("-").map(Number);
        return Date.UTC(y, m - 1, d);
    };
    return Math.round((p(b) - p(a)) / 86400000);
}

/**
 * First instant (UTC) whose local date in `tz` is >= `date`.
 * Local date is monotone in time, so binary-search minutes inside a +-2 day window.
 * Handles DST (23h/25h days) and zones whose midnight does not exist.
 */
export function localDayStartUtc(date: string, tz: string): Date {
    const [y, m, d] = date.split("-").map(Number);
    const base = Date.UTC(y, m - 1, d);
    let lo = base - 2 * 86400000; // local date certainly < date (max offset is +-14h)
    let hi = base + 2 * 86400000; // local date certainly >= date
    const MIN = 60000;
    lo = Math.floor(lo / MIN);
    hi = Math.floor(hi / MIN);
    while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (localDateString(new Date(mid * MIN), tz) >= date) hi = mid;
        else lo = mid;
    }
    return new Date(hi * MIN);
}

/** [start, end) UTC bounds of a local calendar day. */
export function localDayBoundsUtc(date: string, tz: string): { start: Date; end: Date } {
    return {
        start: localDayStartUtc(date, tz),
        end: localDayStartUtc(addDays(date, 1), tz),
    };
}

/** Season day (1-based) of `now`, given the season's local start date. Never below 1. */
export function seasonDayFor(startDate: string, tz: string, now: Date): number {
    return Math.max(1, daysBetween(startDate, localDateString(now, tz)) + 1);
}

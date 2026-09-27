import {
    addDays,
    daysBetween,
    isValidTimezone,
    localDateString,
    localDayBoundsUtc,
    seasonDayFor,
} from "./mosaic.time";

const H = 3600000;

describe("mosaic timezone helpers", () => {
    it("validates IANA zones and rejects junk", () => {
        expect(isValidTimezone("Asia/Riyadh")).toBe(true);
        expect(isValidTimezone("America/New_York")).toBe(true);
        expect(isValidTimezone("Not/AZone")).toBe(false);
        expect(isValidTimezone("")).toBe(false);
        expect(isValidTimezone(undefined)).toBe(false);
        expect(isValidTimezone("x".repeat(65))).toBe(false);
    });

    it("local date differs from UTC date near midnight", () => {
        const t = new Date("2026-06-10T22:30:00Z");
        expect(localDateString(t, "UTC")).toBe("2026-06-10");
        expect(localDateString(t, "Asia/Riyadh")).toBe("2026-06-11"); // UTC+3
        expect(localDateString(t, "America/Los_Angeles")).toBe("2026-06-10"); // UTC-7
        expect(localDateString(t, "Pacific/Kiritimati")).toBe("2026-06-11"); // UTC+14
        expect(localDateString(t, "Etc/GMT+12")).toBe("2026-06-10"); // UTC-12
    });

    it("day boundaries are exact at local midnight (Riyadh, no DST)", () => {
        const { start, end } = localDayBoundsUtc("2026-06-11", "Asia/Riyadh");
        expect(start.toISOString()).toBe("2026-06-10T21:00:00.000Z");
        expect(end.toISOString()).toBe("2026-06-11T21:00:00.000Z");
        // 1 ms before local midnight is still the previous day
        expect(localDateString(new Date(start.getTime() - 1), "Asia/Riyadh")).toBe("2026-06-10");
        expect(localDateString(start, "Asia/Riyadh")).toBe("2026-06-11");
    });

    it("DST spring-forward day is 23h (America/New_York 2026-03-08)", () => {
        const { start, end } = localDayBoundsUtc("2026-03-08", "America/New_York");
        expect(start.toISOString()).toBe("2026-03-08T05:00:00.000Z"); // EST
        expect(end.toISOString()).toBe("2026-03-09T04:00:00.000Z"); // EDT
        expect((end.getTime() - start.getTime()) / H).toBe(23);
    });

    it("DST fall-back day is 25h (America/New_York 2026-11-01)", () => {
        const { start, end } = localDayBoundsUtc("2026-11-01", "America/New_York");
        expect(start.toISOString()).toBe("2026-11-01T04:00:00.000Z"); // EDT
        expect(end.toISOString()).toBe("2026-11-02T05:00:00.000Z"); // EST
        expect((end.getTime() - start.getTime()) / H).toBe(25);
    });

    it("every instant belongs to exactly one local day across a DST week", () => {
        for (const tz of ["America/New_York", "Europe/Berlin", "Australia/Lord_Howe", "Asia/Riyadh"]) {
            let date = "2026-03-05";
            let prevEnd: number | null = null;
            for (let i = 0; i < 10; i++) {
                const { start, end } = localDayBoundsUtc(date, tz);
                if (prevEnd !== null) expect(start.getTime()).toBe(prevEnd); // contiguous, no gap/overlap
                expect(end.getTime()).toBeGreaterThan(start.getTime());
                prevEnd = end.getTime();
                date = addDays(date, 1);
            }
        }
    });

    it("season day advances at LOCAL midnight, not UTC midnight", () => {
        const tz = "Asia/Riyadh";
        expect(seasonDayFor("2026-06-10", tz, new Date("2026-06-10T20:59:59Z"))).toBe(1);
        expect(seasonDayFor("2026-06-10", tz, new Date("2026-06-10T21:00:00Z"))).toBe(2);
        expect(seasonDayFor("2026-06-10", tz, new Date("2026-07-09T20:59:59Z"))).toBe(30);
        expect(seasonDayFor("2026-06-10", tz, new Date("2026-07-09T21:00:00Z"))).toBe(31);
    });

    it("season day never drops below 1 and date math is exact", () => {
        expect(seasonDayFor("2026-06-10", "UTC", new Date("2026-06-01T00:00:00Z"))).toBe(1);
        expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
        expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    });
});

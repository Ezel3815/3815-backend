import { MOSAIC_CONFIG, cumulativeAllowance } from "./mosaic.config";
import {
    DayCounts,
    EMPTY_LEDGER,
    chestPiecesToAward,
    chestStatus,
    isActiveDay,
    planDay,
    stepState,
} from "./mosaic.engine";

type Act = (day: number) => number; // reviews on that local day (mastered/chapter derived below)
interface Sim { hist: number[]; finish: number | null; daily: number; chests: number }

const CH = MOSAIC_CONFIG.chest;
const counts = (r: number, chapter = false): DayCounts => ({
    reviews: r,
    mastered: r >= 10 ? Math.min(r, 50) : 0, // studying >=10 cards includes >=5 mastered
    chapterDone: chapter,
});

/** Runs the REAL engine day by day, like the service does; chests opened ASAP unless delayed. */
function simulate(
    act: Act,
    o: { horizon?: number; chestDay?: Record<number, number>; stepsCap?: Record<number, DayCounts> } = {},
): Sim {
    const horizon = o.horizon ?? 150;
    let daily = 0, chestPieces = 0, opened = 0, activeDays = 0, totalReviews = 0;
    const hist: number[] = [];
    let finish: number | null = null;
    for (let day = 1; day <= horizon; day++) {
        const c = o.stepsCap?.[day] ?? counts(act(day));
        const plan = planDay(day, c, EMPTY_LEDGER, daily);
        daily += plan.scheduledNew + plan.catchupNew;
        expect(daily).toBeLessThanOrEqual(cumulativeAllowance(day)); // pacing ceiling
        if (isActiveDay(c.reviews)) activeDays++;
        totalReviews += c.reviews;
        while (opened < CH.days.length) {
            const k = opened + 1;
            const st = chestStatus(k, { day, activeDays, totalReviews, claimed: false });
            if (!st.ready || day < (o.chestDay?.[k] ?? 0)) break;
            chestPieces += chestPiecesToAward(daily + chestPieces);
            opened++;
        }
        const total = daily + chestPieces;
        expect(total).toBeLessThanOrEqual(100);
        hist.push(total);
        if (total >= 100 && finish === null) { finish = day; break; }
    }
    return { hist, finish, daily, chests: opened };
}

const MAX = 200; // "max effort": cap-limited, not effort-limited
const always: Act = () => MAX;
const missing = (days: number[], e = MAX): Act => (d) => (days.includes(d) ? 0 : e);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const day30 = (s: Sim) => s.hist[29] ?? 100;

describe("mosaic engine: steps", () => {
    it("study 10 reviews, mastery 5 mastered, challenge = 25 reviews OR a chapter", () => {
        expect(stepState({ reviews: 9, mastered: 5, chapterDone: false }).study).toBe(false);
        expect(stepState({ reviews: 10, mastered: 4, chapterDone: false }).mastery).toBe(false);
        expect(stepState({ reviews: 10, mastered: 5, chapterDone: false })).toMatchObject({ study: true, mastery: true, challenge: false, done: 2 });
        expect(stepState({ reviews: 24, mastered: 5, chapterDone: false }).challenge).toBe(false);
        expect(stepState({ reviews: 25, mastered: 5, chapterDone: false }).challenge).toBe(true);
        expect(stepState({ reviews: 10, mastered: 5, chapterDone: true }).challenge).toBe(true);
    });
});

describe("mosaic engine: scenarios A-J (Option A, R2 catch-up)", () => {
    it("A perfect user (30 reviews/day) finishes exactly Day 30", () => {
        const s = simulate(() => 30);
        expect(s.finish).toBe(30);
        expect(s.hist[28]).toBe(98); // Day 29 < 100
        expect([7, 14, 15, 21, 28, 29, 30].map((d) => s.hist[d - 1])).toEqual([24, 48, 50, 71, 95, 98, 100]);
    });
    it("A perfect user at max effort still finishes Day 30", () => expect(simulate(always).finish).toBe(30));

    it.each([
        ["B miss 1 (Day 10)", [10], 100, 30],
        ["B miss 1 (Day 29)", [29], 100, 30],
        ["B miss 1 (Day 30)", [30], 98, 31],
        ["C miss 3 (Days 10-12)", range(10, 12), 100, 30],
        ["C miss 3 (Days 28-30)", range(28, 30), 92, 32],
        ["D miss 5 (Days 10-14)", range(10, 14), 100, 30],
        ["D miss 5 (Days 26-30)", range(26, 30), 87, 34],
        ["E miss 7 (Days 8-14)", range(8, 14), 100, 30],
        ["E miss 7 (Days 24-30)", range(24, 30), 82, 35],
    ])("%s -> Day 30 = %i, finishes Day %i", (_n, miss, d30, fin) => {
        const s = simulate(missing(miss as number[]));
        expect(day30(s)).toBe(d30);
        expect(s.finish).toBe(fin);
    });

    it("F active 4 days/week and opens all chests -> 100 on Day 30", () => {
        const s = simulate((d) => ((d - 1) % 7 < 4 ? MAX : 0));
        expect(day30(s)).toBe(100);
        expect(s.finish).toBe(30);
    });
    it("F' active only 3 days/week (the chest minimum) -> 83 on Day 30, finishes Day 43", () => {
        const s = simulate((d) => ((d - 1) % 7 < 3 ? MAX : 0));
        expect(day30(s)).toBe(83);
        expect(s.finish).toBe(43);
    });

    it("G chest claimed late does not change the total or lose pieces", () => {
        expect(simulate(always, { chestDay: { 2: 25 } }).finish).toBe(30);
        expect(simulate(always, { chestDay: { 4: 30 } }).finish).toBe(30);
        const s = simulate(missing([5, 6]), { chestDay: { 1: 29, 2: 29 } });
        expect(day30(s)).toBe(100);
    });

    it("H 99/100: one catch-up piece left -> takes slot 100", () => {
        // Day 30 with only 1 step done: 98 + 1 = 99
        const s = simulate(always, { stepsCap: { 30: { reviews: 10, mastered: 0, chapterDone: false } } });
        expect(s.hist[29]).toBe(99);
        expect(s.finish).toBe(31); // Day 31 catch-up completes it
        expect(s.hist[30]).toBe(100);
    });

    it("I 100/100: nothing can be awarded any more (chest capped to 0, catch-up limited by backlog)", () => {
        expect(chestPiecesToAward(100)).toBe(0);
        expect(chestPiecesToAward(99)).toBe(1);
        expect(chestPiecesToAward(96)).toBe(4);
        expect(chestPiecesToAward(0)).toBe(5);
        const plan = planDay(45, counts(500), EMPTY_LEDGER, 80);
        expect(plan.scheduledNew + plan.catchupNew).toBe(0);
        expect(plan.backlogAfter).toBe(0);
    });

    it("J reaches Day 30 below 100 -> stays in catch-up and can still finish", () => {
        const s = simulate(missing(range(26, 30)));
        expect(day30(s)).toBeLessThan(100);
        expect(s.finish).toBe(34);
    });

    it("latest return day that can still finish by Day 30 (max effort) is Day 14", () => {
        const latest = (() => {
            let best = 0;
            for (let s = 1; s <= 30; s++)
                if ((simulate((d) => (d >= s ? MAX : 0)).finish ?? 999) <= 30) best = s;
            return best;
        })();
        expect(latest).toBe(14);
    });
});

describe("mosaic engine: invariants", () => {
    // small deterministic PRNG
    const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

    it("fuzz: never > 100, never above the pacing ceiling, never finishes before Day 30", () => {
        const r = rng(7);
        const profiles = [[0, 10, 25, 40], [0, 10, 25, 100, 1000], [0, 25, 60], [100000], [0, 0, 0, 5000]];
        let earliest = 999;
        for (let i = 0; i < 1500; i++) {
            const p = profiles[Math.floor(r() * profiles.length)];
            const acts = Array.from({ length: 151 }, () => p[Math.floor(r() * p.length)]);
            const s = simulate((d) => acts[d]); // asserts ceiling + <=100 each day
            if (s.finish) earliest = Math.min(earliest, s.finish);
        }
        expect(earliest).toBe(30);
    });

    it("extreme grinder (100,000 reviews every day) cannot finish before Day 30", () => {
        const s = simulate(() => 100000);
        expect(s.finish).toBe(30);
        expect(s.hist[28]).toBe(98);
    });

    it("dormant then binge on Days 28-30 is bounded by the ceiling and chest requirements", () => {
        const s = simulate((d) => (d >= 28 ? 100000 : 0), { horizon: 30 });
        expect(s.hist.slice(27)).toEqual([5, 12, 23]);
    });

    it("catch-up can never exceed backlog or bypass the ceiling", () => {
        // 60 days of nothing, then one 100k-review day: still capped at scheduled(0..) + 4 catch-up
        const plan = planDay(60, counts(100000, true), EMPTY_LEDGER, 0);
        expect(plan.scheduledNew).toBe(0); // allowance is 0 after Day 30
        expect(plan.catchupNew).toBe(4);
        expect(plan.backlogAfter).toBe(76);
    });

    it("is idempotent: re-evaluating with the same counts and the persisted ledger awards nothing", () => {
        let owned = 0, ledger = EMPTY_LEDGER;
        for (const r of [3, 10, 12, 25, 25, 40, 40, 90, 90]) {
            const plan = planDay(5, counts(r), ledger, owned);
            owned += plan.scheduledNew + plan.catchupNew;
            ledger = plan.ledger;
        }
        const again = planDay(5, counts(90), ledger, owned);
        expect(again.scheduledNew + again.catchupNew).toBe(0);
    });

    it("incremental evaluation during the day equals one evaluation at the end", () => {
        const end = planDay(9, counts(45), EMPTY_LEDGER, 0);
        let owned = 0, ledger = EMPTY_LEDGER;
        for (const r of [1, 5, 10, 17, 25, 26, 35, 45]) {
            const p = planDay(9, counts(r), ledger, owned);
            owned += p.scheduledNew + p.catchupNew;
            ledger = p.ledger;
        }
        expect(owned).toBe(end.scheduledNew + end.catchupNew);
    });

    it("progress never goes backwards when answers are re-graded worse", () => {
        const a = planDay(2, counts(25), EMPTY_LEDGER, 0);
        const b = planDay(2, { reviews: 3, mastered: 0, chapterDone: false }, a.ledger, a.scheduledNew);
        expect(b.scheduledNew + b.catchupNew).toBe(0);
        expect(b.ledger.reviews).toBe(25);
    });

    it("chests need day AND cumulative activity, so they cannot be burst-opened", () => {
        expect(chestStatus(1, { day: 6, activeDays: 9, totalReviews: 999, claimed: false }).ready).toBe(false);
        expect(chestStatus(1, { day: 7, activeDays: 2, totalReviews: 999, claimed: false }).ready).toBe(false);
        expect(chestStatus(1, { day: 7, activeDays: 3, totalReviews: 49, claimed: false }).ready).toBe(false);
        expect(chestStatus(1, { day: 7, activeDays: 3, totalReviews: 50, claimed: false }).ready).toBe(true);
        expect(chestStatus(4, { day: 40, activeDays: 11, totalReviews: 999, claimed: false }).ready).toBe(false);
        expect(chestStatus(4, { day: 40, activeDays: 12, totalReviews: 200, claimed: true }).ready).toBe(false);
    });
});

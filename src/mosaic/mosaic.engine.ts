import { MOSAIC_CONFIG, catchUpCap, cumulativeAllowance, dailyAllowance } from "./mosaic.config";

/**
 * Pure reward rules. No I/O. The service feeds it counts read from the DB and
 * persists whatever it returns. Vocabulary:
 *   SCHEDULED pieces = released on their own day, at most dailyAllowance(day).
 *   CATCH-UP pieces  = recover backlog (ceiling - owned daily pieces) only.
 *   CHEST pieces     = separate budget (4 x 5).
 * There is no way to create a piece outside this budget.
 */

export interface DayCounts {
    reviews: number;
    mastered: number;
    chapterDone: boolean;
}

export interface DayLedger extends DayCounts {
    scheduledReleased: number;
    catchupReleased: number;
}

export const EMPTY_LEDGER: DayLedger = {
    reviews: 0,
    mastered: 0,
    chapterDone: false,
    scheduledReleased: 0,
    catchupReleased: 0,
};

export interface StepState {
    study: boolean;
    mastery: boolean;
    challenge: boolean;
    done: number;
}

export function stepState(c: DayCounts): StepState {
    const s = MOSAIC_CONFIG.steps;
    const study = c.reviews >= s.studyReviews;
    const mastery = c.mastered >= s.masteryCards;
    const challenge = c.reviews >= s.challengeReviews || c.chapterDone;
    return { study, mastery, challenge, done: +study + +mastery + +challenge };
}

export interface DayPlan {
    /** New ledger values for today (counters only ever go up). */
    ledger: DayLedger;
    steps: StepState;
    scheduledNew: number;
    catchupNew: number;
    /** Unrecovered scheduled daily pieces after today's awards. */
    backlogAfter: number;
}

/**
 * Plan today's daily awards.
 * @param day        season day (1-based, may exceed seasonDays)
 * @param live       counts just read from the DB for today's local day
 * @param ledger     what the MosaicDay row already says (EMPTY_LEDGER if none)
 * @param dailyOwned scheduled+catch-up pieces the user already owns (all days)
 */
export function planDay(
    day: number,
    live: DayCounts,
    ledger: DayLedger,
    dailyOwned: number,
): DayPlan {
    // Monotone snapshot: re-answering a card worse can never take progress away.
    const merged: DayCounts = {
        reviews: Math.max(ledger.reviews, live.reviews),
        mastered: Math.max(ledger.mastered, live.mastered),
        chapterDone: ledger.chapterDone || live.chapterDone,
    };
    const steps = stepState(merged);
    const ceiling = cumulativeAllowance(day);

    // Scheduled: min(steps completed, today's allowance), never above the ceiling.
    const target = Math.min(steps.done, dailyAllowance(day));
    const scheduledNew = clamp(
        Math.min(target - ledger.scheduledReleased, ceiling - dailyOwned),
    );
    const ownedAfterScheduled = dailyOwned + scheduledNew;

    // Catch-up: only after 3/3 steps, only from backlog, capped per day.
    let catchupNew = 0;
    if (steps.done === 3) {
        const cu = MOSAIC_CONFIG.catchUp;
        const fromReviews =
            merged.reviews > MOSAIC_CONFIG.steps.challengeReviews
                ? Math.floor(
                      (merged.reviews - MOSAIC_CONFIG.steps.challengeReviews) /
                          cu.stepReviews,
                  )
                : 0;
        const allowedToday = Math.min(catchUpCap(day), fromReviews);
        const backlog = ceiling - ownedAfterScheduled;
        catchupNew = clamp(Math.min(allowedToday - ledger.catchupReleased, backlog));
    }

    return {
        ledger: {
            ...merged,
            scheduledReleased: ledger.scheduledReleased + scheduledNew,
            catchupReleased: ledger.catchupReleased + catchupNew,
        },
        steps,
        scheduledNew,
        catchupNew,
        backlogAfter: ceiling - ownedAfterScheduled - catchupNew,
    };
}

export interface ChestInput {
    day: number;
    activeDays: number;
    totalReviews: number;
    claimed: boolean;
}

export interface ChestStatus {
    index: number; // 1-based
    unlockDay: number;
    reachedDay: boolean;
    activeDaysNeed: number;
    reviewsNeed: number;
    requirementMet: boolean;
    ready: boolean;
    claimed: boolean;
}

export function chestStatus(index: number, i: ChestInput): ChestStatus {
    const c = MOSAIC_CONFIG.chest;
    const unlockDay = c.days[index - 1];
    const activeDaysNeed = c.minActiveDaysEach * index;
    const reviewsNeed = c.minReviewsEach * index;
    const reachedDay = i.day >= unlockDay;
    const requirementMet =
        i.activeDays >= activeDaysNeed && i.totalReviews >= reviewsNeed;
    return {
        index,
        unlockDay,
        reachedDay,
        activeDaysNeed,
        reviewsNeed,
        requirementMet,
        ready: reachedDay && requirementMet && !i.claimed,
        claimed: i.claimed,
    };
}

/** How many pieces a chest may still add: never beyond the total. */
export function chestPiecesToAward(owned: number): number {
    return clamp(Math.min(MOSAIC_CONFIG.chest.pieces, MOSAIC_CONFIG.totalPieces - owned));
}

export const isActiveDay = (reviews: number) =>
    reviews >= MOSAIC_CONFIG.activeDayMinReviews;

function clamp(n: number): number {
    return Math.max(0, n);
}

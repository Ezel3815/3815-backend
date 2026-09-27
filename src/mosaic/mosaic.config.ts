/**
 * Mozaik mosaic economy. ONE painting, 30-day season, EXACTLY 100 pieces.
 * Everything tunable lives here; nothing else hard-codes economy numbers.
 * Pure module (no Prisma / Nest imports) so it can be unit-tested directly.
 *
 *   100 = 80 scheduled daily pieces (pattern [3,3,2] x 10)
 *       + 20 chest pieces (4 weekly chests x 5, Days 7/14/21/28)
 */

export const MOSAIC_ARTWORK_ID = "garden-by-the-sea-01";

/** Piece IDs in the order they are awarded (copied from pieces.json `revealOrder`). */
export const REVEAL_ORDER: readonly number[] = [
    56, 45, 46, 55, 57, 66, 65, 36, 44, 47,
    35, 54, 67, 37, 64, 34, 58, 76, 48, 75,
    26, 25, 53, 43, 38, 27, 77, 68, 63, 33,
    24, 74, 86, 52, 23, 85, 28, 78, 59, 16,
    15, 49, 73, 17, 42, 39, 62, 87, 32, 84,
    69, 14, 79, 22, 18, 72, 88, 13, 29, 83,
    51, 96, 6, 60, 50, 95, 41, 5, 7, 97,
    4, 40, 61, 94, 19, 70, 31, 82, 89, 21,
    93, 12, 8, 80, 98, 3, 71, 30, 92, 99,
    90, 9, 20, 2, 81, 11, 91, 100, 10, 1,
];

export const MOSAIC_CONFIG = {
    artworkId: MOSAIC_ARTWORK_ID,
    totalPieces: 100,
    seasonDays: 30,
    /** Repeats for the whole season: day 1 -> 3, day 2 -> 3, day 3 -> 2, day 4 -> 3 ... */
    dailyPattern: [3, 3, 2] as readonly number[],
    chest: {
        days: [7, 14, 21, 28] as readonly number[],
        pieces: 5,
        xp: 100,
        /** Cumulative requirements: chest k needs k * value. */
        minActiveDaysEach: 3,
        minReviewsEach: 50,
    },
    /** A local day with at least this many reviews counts as "active". */
    activeDayMinReviews: 10,
    steps: { studyReviews: 10, masteryCards: 5, challengeReviews: 25 },
    catchUp: {
        stepReviews: 10,
        cap: 2,
        finalPushFromDay: 29,
        finalPushCap: 4,
    },
} as const;

/** Scheduled allowance for a season day (1-based). 0 after the season. */
export function dailyAllowance(day: number): number {
    if (day < 1 || day > MOSAIC_CONFIG.seasonDays) return 0;
    const p = MOSAIC_CONFIG.dailyPattern;
    return p[(day - 1) % p.length];
}

/** Pacing ceiling D(day): max cumulative scheduled+catch-up daily pieces by `day`. */
export function cumulativeAllowance(day: number): number {
    const last = Math.min(day, MOSAIC_CONFIG.seasonDays);
    let sum = 0;
    for (let d = 1; d <= last; d++) sum += dailyAllowance(d);
    return sum;
}

export function catchUpCap(day: number): number {
    const c = MOSAIC_CONFIG.catchUp;
    return day >= c.finalPushFromDay ? c.finalPushCap : c.cap;
}

export const CHEST_COUNT = MOSAIC_CONFIG.chest.days.length;
export const MAX_DAILY_PIECES = cumulativeAllowance(MOSAIC_CONFIG.seasonDays);
export const MAX_CHEST_PIECES = CHEST_COUNT * MOSAIC_CONFIG.chest.pieces;

/** Throws if the economy does not add up to exactly `totalPieces`. Called at module load. */
export function assertMosaicConfig(): void {
    if (MAX_DAILY_PIECES + MAX_CHEST_PIECES !== MOSAIC_CONFIG.totalPieces)
        throw new Error(
            `Mosaic economy mismatch: daily ${MAX_DAILY_PIECES} + chest ${MAX_CHEST_PIECES} != ${MOSAIC_CONFIG.totalPieces}`,
        );
    if (
        REVEAL_ORDER.length !== MOSAIC_CONFIG.totalPieces ||
        new Set(REVEAL_ORDER).size !== MOSAIC_CONFIG.totalPieces
    )
        throw new Error("REVEAL_ORDER must contain totalPieces unique ids");
}
assertMosaicConfig();

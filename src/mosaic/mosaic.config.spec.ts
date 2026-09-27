import {
    MAX_CHEST_PIECES,
    MAX_DAILY_PIECES,
    MOSAIC_CONFIG,
    REVEAL_ORDER,
    assertMosaicConfig,
    catchUpCap,
    cumulativeAllowance,
    dailyAllowance,
} from "./mosaic.config";

describe("mosaic config / economy", () => {
    it("adds up to exactly 100 (80 daily + 20 chest)", () => {
        expect(MAX_DAILY_PIECES).toBe(80);
        expect(MAX_CHEST_PIECES).toBe(20);
        expect(MAX_DAILY_PIECES + MAX_CHEST_PIECES).toBe(MOSAIC_CONFIG.totalPieces);
        expect(() => assertMosaicConfig()).not.toThrow();
    });

    it("follows the locked Option A curve [3,3,2] x 10", () => {
        const curve = Array.from({ length: 30 }, (_, i) => dailyAllowance(i + 1));
        expect(curve).toEqual(Array.from({ length: 10 }, () => [3, 3, 2]).flat());
        expect(dailyAllowance(31)).toBe(0);
        expect(dailyAllowance(0)).toBe(0);
    });

    it("has the approved cumulative maximums (daily + chests opened by that day)", () => {
        const chestsBy = (d: number) => MOSAIC_CONFIG.chest.days.filter((x) => x <= d).length * 5;
        const cum = (d: number) => cumulativeAllowance(d) + chestsBy(d);
        expect([7, 14, 15, 21, 28, 29, 30].map(cum)).toEqual([24, 48, 50, 71, 95, 98, 100]);
        expect(cum(60)).toBe(100);
    });

    it("reveal order is a permutation of 1..100", () => {
        expect([...REVEAL_ORDER].sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    });

    it("R2 catch-up caps: 2/day until Day 28, 4/day from Day 29", () => {
        expect(catchUpCap(1)).toBe(2);
        expect(catchUpCap(28)).toBe(2);
        expect(catchUpCap(29)).toBe(4);
        expect(catchUpCap(90)).toBe(4);
    });
});

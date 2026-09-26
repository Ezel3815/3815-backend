import { PrismaClient } from "@prisma/client";
import { MOSAIC_CONFIG, REVEAL_ORDER, cumulativeAllowance } from "./mosaic.config";
import { MosaicService } from "./mosaic.service";
import { createTestPrisma } from "./mosaic.testing";

const RUN = !!process.env.MOSAIC_TEST_DATABASE_URL;
const d = RUN ? describe : describe.skip; // DB-backed: see mosaic.testing.ts
const ART = MOSAIC_CONFIG.artworkId;
const RIYADH = "Asia/Riyadh"; // UTC+3, no DST
const T = (iso: string) => new Date(iso);
/** Local noon in Riyadh on season day n, given Day 1 = 2026-06-10 */
const riyadhNoon = (day: number) => new Date(Date.UTC(2026, 5, 10 + day - 1, 9, 0, 0));

d("MosaicService (real database)", () => {
    let prisma: PrismaClient;
    let svc: MosaicService;
    let cardIds: number[] = [];
    let seq = 0;

    beforeAll(async () => {
        prisma = createTestPrisma();
        svc = new MosaicService(prisma as any);
        const deck = await prisma.deck.create({ data: { title: `mosaic-test-${Date.now()}` } });
        const rows = await Promise.all(
            Array.from({ length: 120 }, (_, i) =>
                prisma.card.create({ data: { order: i, deck_id: deck.id, type: "BASIC", data: {} } }),
            ),
        );
        cardIds = rows.map((c) => c.id);
    }, 60000);
    afterAll(async () => prisma.$disconnect());

    const newUser = async (timezone: string | null = RIYADH) =>
        prisma.user.create({
            data: { email: `m${Date.now()}_${seq++}@t.test`, password: "x", name: "T", timezone },
        });

    /** Makes the user's next-N distinct cards (from `offset`) "answered at `at`"
     *  (like re-reviews overwrite updated_at). Concurrent callers should use
     *  disjoint offsets — Prisma's upsert() isn't atomic across two truly
     *  simultaneous creates for the same composite-key row. */
    const study = async (
        userId: number,
        n: number,
        at: Date,
        answer: "GOOD" | "EASY" | "AGAIN" = "GOOD",
        offset = 0,
    ) => {
        for (let i = offset; i < offset + n; i++) {
            await prisma.cardAnswer.upsert({
                where: { user_id_card_id: { user_id: userId, card_id: cardIds[i] } },
                create: { user_id: userId, card_id: cardIds[i], answer, created_at: at, updated_at: at },
                update: { answer, updated_at: at },
            });
        }
    };
    const pieces = (userId: number) =>
        prisma.mosaicPiece.findMany({ where: { user_id: userId, artwork_id: ART }, orderBy: { slot: "asc" } });

    it("without a timezone: no season, no pieces, clear status", async () => {
        const u = await newUser(null);
        svc.clock = () => riyadhNoon(1);
        await study(u.id, 30, riyadhNoon(1));
        const r = await svc.onAnswer(u.id);
        expect(r.status).toBe("timezone_required");
        expect(await pieces(u.id)).toHaveLength(0);
        expect(await prisma.mosaicSeason.count({ where: { user_id: u.id } })).toBe(0);
        expect((await svc.getState(u.id)).status).toBe("timezone_required");
    });

    it("awards the real piece from reveal order and persists it (survives 'app close')", async () => {
        const u = await newUser();
        svc.clock = () => riyadhNoon(1);
        await study(u.id, 10, riyadhNoon(1)); // study + mastery -> 2 pieces (Day 1 allowance is 3)
        const r = await svc.onAnswer(u.id);
        expect(r.newPieces.map((p) => p.pieceId)).toEqual([REVEAL_ORDER[0], REVEAL_ORDER[1]]);
        expect(r.newPieces.map((p) => p.slot)).toEqual([1, 2]);
        // a "second device / reopened app" only has the database:
        const state: any = await svc.getState(u.id);
        expect(state.piecesEarned).toBe(2);
        expect(state.pieces.map((p: any) => p.pieceId)).toEqual([REVEAL_ORDER[0], REVEAL_ORDER[1]]);
        expect(state.pieces.every((p: any) => p.revealed === false)).toBe(true);
        expect(state.today.stepsDone).toBe(2);
    });

    it("double submit: repeated and concurrent onAnswer never duplicate a reward", async () => {
        const u = await newUser();
        svc.clock = () => riyadhNoon(1);
        await study(u.id, 30, riyadhNoon(1)); // 3/3 steps -> 3 pieces
        await svc.onAnswer(u.id);
        await svc.onAnswer(u.id);
        expect(await pieces(u.id)).toHaveLength(3);

        const u2 = await newUser();
        await study(u2.id, 30, riyadhNoon(1));
        const results = await Promise.all(Array.from({ length: 10 }, () => svc.onAnswer(u2.id)));
        const rows = await pieces(u2.id);
        expect(rows).toHaveLength(3);
        expect(rows.map((p) => p.slot)).toEqual([1, 2, 3]);
        expect(new Set(rows.map((p) => p.piece_id)).size).toBe(3);
        expect(results.reduce((a, r) => a + r.newPieces.length, 0)).toBe(3); // reported exactly once overall
    }, 60000);

    it("concurrent answers while progress grows still end at the exact allowance", async () => {
        const u = await newUser();
        svc.clock = () => riyadhNoon(1);
        const jobs: Promise<unknown>[] = [];
        let offset = 0;
        for (const n of [5, 10, 15, 25, 30]) {
            // Disjoint card ranges per job — these run truly concurrently, and
            // upsert() isn't atomic across simultaneous creates for the same
            // composite-key row, so overlapping ranges would race spuriously.
            jobs.push(study(u.id, n, riyadhNoon(1), "GOOD", offset).then(() => svc.onAnswer(u.id)));
            offset += n;
        }
        await Promise.all(jobs);
        await svc.onAnswer(u.id);
        const rows = await pieces(u.id);
        expect(rows).toHaveLength(3);
        expect(rows.map((p) => p.slot)).toEqual([1, 2, 3]);
    }, 60000);

    it("DB constraints reject duplicate slot / piece id / source key", async () => {
        const u = await newUser();
        const base = { user_id: u.id, artwork_id: ART, kind: "CHEST", season_day: 1 };
        await prisma.mosaicPiece.create({ data: { ...base, slot: 1, piece_id: 5, source_key: "a" } });
        await expect(prisma.mosaicPiece.create({ data: { ...base, slot: 1, piece_id: 6, source_key: "b" } })).rejects.toMatchObject({ code: "P2002" });
        await expect(prisma.mosaicPiece.create({ data: { ...base, slot: 2, piece_id: 5, source_key: "c" } })).rejects.toMatchObject({ code: "P2002" });
        await expect(prisma.mosaicPiece.create({ data: { ...base, slot: 2, piece_id: 6, source_key: "a" } })).rejects.toMatchObject({ code: "P2002" });
    });

    it("hard cap: a 101st piece is never created", async () => {
        const u = await newUser();
        await prisma.mosaicSeason.create({ data: { user_id: u.id, artwork_id: ART, timezone: RIYADH, start_date: "2026-06-10" } });
        for (let s = 1; s <= 100; s++)
            await prisma.mosaicPiece.create({
                data: { user_id: u.id, artwork_id: ART, slot: s, piece_id: REVEAL_ORDER[s - 1], kind: "SCHEDULED", source_key: `seed:${s}`, season_day: 1 },
            });
        const out = await prisma.$transaction((tx) =>
            (svc as any).createPieces(tx, u.id, 100, [{ kind: "CHEST", key: "over:1" }, { kind: "CATCH_UP", key: "over:2" }], 3),
        );
        expect(out).toEqual([]);
        expect(await pieces(u.id)).toHaveLength(100);
    });

    it("weekly chest: needs day + cumulative activity, opens once, concurrent claims give exactly 5", async () => {
        const u = await newUser();
        // Days 1-3: 30 reviews each (3 active days, 90 reviews) -> chest 1 needs Day 7
        for (const day of [1, 2, 3]) {
            svc.clock = () => riyadhNoon(day);
            await study(u.id, 30, riyadhNoon(day));
            await svc.onAnswer(u.id);
        }
        svc.clock = () => riyadhNoon(6);
        await expect(svc.claimChest(u.id, "mosaic_chest_1")).rejects.toThrow(/not ready/);
        svc.clock = () => riyadhNoon(7);
        await expect(svc.claimChest(u.id, "mosaic_chest_2")).rejects.toThrow(/not ready/);
        await expect(svc.claimChest(u.id, "mosaic_chest_9")).rejects.toThrow(/Unknown/);

        const before = (await pieces(u.id)).length; // 3+3+2 = 8 scheduled
        expect(before).toBe(8);
        const results = await Promise.allSettled(Array.from({ length: 6 }, () => svc.claimChest(u.id, "mosaic_chest_1")));
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((r) => r.status === "rejected")).toHaveLength(5);
        const ok: any = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>).value;
        expect(ok.xp).toBe(100);
        expect(ok.mosaic.piecesAwarded).toBe(5);
        const rows = await pieces(u.id);
        expect(rows).toHaveLength(13);
        expect(rows.filter((p) => p.kind === "CHEST")).toHaveLength(5);
        await expect(svc.claimChest(u.id, "mosaic_chest_1")).rejects.toThrow(/already opened/);
        expect((await prisma.user.findUnique({ where: { id: u.id } }))!.xp).toBe(100);
    }, 60000);

    it("local midnight (Riyadh): the season day and daily ledger roll over at 00:00 local, not UTC", async () => {
        const u = await newUser();
        svc.clock = () => T("2026-06-10T20:59:00Z"); // 23:59 local, Day 1
        await study(u.id, 30, T("2026-06-10T20:59:00Z"));
        await svc.onAnswer(u.id);
        expect(await pieces(u.id)).toHaveLength(3); // Day 1 allowance 3
        svc.clock = () => T("2026-06-10T21:00:30Z"); // 00:00:30 local, Day 2 (same UTC day!)
        expect((await svc.getState(u.id) as any).seasonDay).toBe(2);
        await svc.onAnswer(u.id); // yesterday's answers are not today's
        expect(await pieces(u.id)).toHaveLength(3);
        await study(u.id, 30, T("2026-06-10T21:01:00Z"));
        await svc.onAnswer(u.id);
        expect(await pieces(u.id)).toHaveLength(6); // Day 2 allowance 3
        const days = await prisma.mosaicDay.findMany({ where: { user_id: u.id }, orderBy: { day_index: "asc" } });
        expect(days.map((x) => [x.day_index, x.local_date])).toEqual([[1, "2026-06-10"], [2, "2026-06-11"]]);
    }, 60000);

    it("DST: New York spring-forward day (23h) still counts as one season day", async () => {
        const u = await newUser("America/New_York");
        svc.clock = () => T("2026-03-08T04:59:00Z"); // 23:59 EST on 03-07
        await study(u.id, 30, T("2026-03-08T04:59:00Z"));
        await svc.onAnswer(u.id);
        const s1: any = await svc.getState(u.id);
        expect(s1.seasonDay).toBe(1);
        svc.clock = () => T("2026-03-08T05:00:00Z"); // 00:00 EST on 03-08 -> Day 2
        expect(((await svc.getState(u.id)) as any).seasonDay).toBe(2);
        svc.clock = () => T("2026-03-09T03:59:00Z"); // 23:59 EDT on 03-08 -> still Day 2
        expect(((await svc.getState(u.id)) as any).seasonDay).toBe(2);
        svc.clock = () => T("2026-03-09T04:00:00Z"); // 00:00 EDT on 03-09 -> Day 3
        expect(((await svc.getState(u.id)) as any).seasonDay).toBe(3);
    }, 60000);

    it("season timezone is frozen at start even if the user's timezone changes later", async () => {
        const u = await newUser(RIYADH);
        svc.clock = () => riyadhNoon(1);
        await study(u.id, 10, riyadhNoon(1));
        await svc.onAnswer(u.id);
        await svc.setTimezone(u.id, "Pacific/Kiritimati");
        await expect(svc.setTimezone(u.id, "Nope/Zone")).rejects.toThrow(/Invalid/);
        const st: any = await svc.getState(u.id);
        expect(st.timezone).toBe(RIYADH);
        expect(st.seasonDay).toBe(1);
    });

    it("getState is read-only and reveal ack is idempotent", async () => {
        const u = await newUser();
        svc.clock = () => riyadhNoon(1);
        await study(u.id, 30, riyadhNoon(1));
        // GET before any onAnswer must not create a season or award anything
        const s0: any = await svc.getState(u.id);
        expect(s0.status).toBe("not_started");
        await svc.getState(u.id);
        expect(await pieces(u.id)).toHaveLength(0);
        await svc.onAnswer(u.id);
        for (let i = 0; i < 3; i++) await svc.getState(u.id);
        expect(await pieces(u.id)).toHaveLength(3);
        const first = REVEAL_ORDER[0];
        expect(await svc.revealPieces(u.id, [first, first, 9999])).toEqual({ revealed: 1 });
        expect(await svc.revealPieces(u.id, [first])).toEqual({ revealed: 0 });
        const st: any = await svc.getState(u.id);
        expect(st.pieces.filter((p: any) => p.revealed)).toHaveLength(1);
    });

    it("FULL SEASON: one perfect user, 30 days, chests on 7/14/21/28 -> exactly 100, completes on Day 30, stays complete", async () => {
        const u = await newUser();
        const total: number[] = [];
        for (let day = 1; day <= 30; day++) {
            svc.clock = () => riyadhNoon(day);
            await study(u.id, 30, riyadhNoon(day)); // re-reviews overwrite updated_at every day, like real life
            await svc.onAnswer(u.id);
            if ([7, 14, 21, 28].includes(day)) await svc.claimChest(u.id, `mosaic_chest_${day / 7}`);
            total.push((await pieces(u.id)).length);
            if (day < 30) expect(total[day - 1]).toBeLessThan(100); // never before Day 30
        }
        expect([7, 14, 15, 21, 28, 29, 30].map((x) => total[x - 1])).toEqual([24, 48, 50, 71, 95, 98, 100]);
        for (let day = 1; day <= 30; day++) expect(total[day - 1] - (total[day - 2] ?? 0)).toBeLessThanOrEqual(cumulativeAllowance(day) + 20);

        const rows = await pieces(u.id);
        expect(rows).toHaveLength(100);
        expect(rows.map((p) => p.piece_id)).toEqual([...REVEAL_ORDER]); // real piece IDs, in reveal order
        expect(new Set(rows.map((p) => p.piece_id)).size).toBe(100);
        expect(rows.filter((p) => p.kind === "CHEST")).toHaveLength(20);
        expect(rows.filter((p) => p.kind !== "CHEST")).toHaveLength(80);
        const season = await prisma.mosaicSeason.findFirst({ where: { user_id: u.id } });
        expect(season!.completed_at).not.toBeNull();

        // 100/100 is permanent: refresh, more studying, later days, chest re-open -> nothing changes
        svc.clock = () => riyadhNoon(45);
        await study(u.id, 60, riyadhNoon(45));
        const again = await svc.onAnswer(u.id);
        expect(again).toMatchObject({ status: "completed", completed: true, newPieces: [] });
        await expect(svc.claimChest(u.id, "mosaic_chest_4")).rejects.toThrow(/already opened/);
        expect(await pieces(u.id)).toHaveLength(100);
        const st: any = await svc.getState(u.id);
        expect(st).toMatchObject({ status: "completed", piecesEarned: 100, piecesRemaining: 0 });
    }, 180000);

    it("catch-up: a missed day is recovered later (R2) without exceeding the ceiling; continues after Day 30", async () => {
        const u = await newUser();
        // Days 1-4 perfect, Day 5 missed, then 55 reviews/day (25 + 3 catch-up steps capped at 2/day) for a while
        for (let day = 1; day <= 12; day++) {
            svc.clock = () => riyadhNoon(day);
            if (day !== 5) await study(u.id, day >= 6 ? 55 : 30, riyadhNoon(day));
            await svc.onAnswer(u.id);
            const n = (await pieces(u.id)).length;
            expect(n).toBeLessThanOrEqual(cumulativeAllowance(day));
        }
        // scheduled through Day 12 = 32; Day 5 missed (-2) recovered by 2/day catch-up
        expect((await pieces(u.id)).length).toBe(cumulativeAllowance(12));
        expect((await pieces(u.id)).some((p) => p.kind === "CATCH_UP")).toBe(true);

        // unfinished user after Day 30 stays in catch-up and can still receive catch-up pieces
        const v = await newUser();
        svc.clock = () => riyadhNoon(40);
        await study(v.id, 100, riyadhNoon(40));
        await svc.onAnswer(v.id); // Day 40, season started now => this is Day 1 for v
        expect((await svc.getState(v.id) as any).seasonDay).toBe(1);
        svc.clock = () => riyadhNoon(75); // Day 36 of v's season
        await study(v.id, 100, riyadhNoon(75));
        const r = await svc.onAnswer(v.id);
        expect(r.status).toBe("catch_up");
        expect(r.newPieces.length).toBeGreaterThan(0);
        expect(r.newPieces.every((p) => p.kind === "CATCH_UP")).toBe(true);
        expect(r.newPieces.length).toBeLessThanOrEqual(4);
    }, 120000);
});

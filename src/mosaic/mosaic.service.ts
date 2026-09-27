import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "nestjs-prisma";
import { getLevelInfo } from "../utils/level.utils";
import {
    CHEST_COUNT,
    MOSAIC_CONFIG,
    REVEAL_ORDER,
    catchUpCap,
    cumulativeAllowance,
    dailyAllowance,
} from "./mosaic.config";
import {
    DayCounts,
    DayLedger,
    EMPTY_LEDGER,
    chestPiecesToAward,
    chestStatus,
    isActiveDay,
    planDay,
    stepState,
} from "./mosaic.engine";
import {
    isValidTimezone,
    localDateString,
    localDayBoundsUtc,
    seasonDayFor,
} from "./mosaic.time";

type Tx = Prisma.TransactionClient;
export type PieceKind = "SCHEDULED" | "CATCH_UP" | "CHEST";
export type MosaicStatus =
    | "timezone_required"
    | "not_started"
    | "active"
    | "catch_up"
    | "completed";

export interface AwardedPiece {
    pieceId: number;
    slot: number;
    kind: PieceKind;
    seasonDay: number;
}

export interface MosaicAward {
    status: MosaicStatus;
    newPieces: AwardedPiece[];
    piecesEarned: number;
    completed: boolean;
}

const ART = MOSAIC_CONFIG.artworkId;
const TOTAL = MOSAIC_CONFIG.totalPieces;
const DAILY_KINDS: PieceKind[] = ["SCHEDULED", "CATCH_UP"];
export const chestId = (k: number) => `mosaic_chest_${k}`;
const claimKey = (k: number) => `claim:${chestId(k)}:${ART}`;

@Injectable()
export class MosaicService {
    /** Overridable clock so tests can drive season days / DST deterministically. */
    clock: () => Date = () => new Date();

    constructor(private prisma: PrismaService) {}

    // ------------------------------------------------------------------ timezone
    async setTimezone(userId: number, timezone: string) {
        if (!isValidTimezone(timezone))
            throw new BadRequestException("Invalid IANA timezone");
        // Existing seasons keep the timezone frozen at their start.
        await this.prisma.user.update({ where: { id: userId }, data: { timezone } });
        return { timezone };
    }

    // ------------------------------------------------------------------ evaluation
    /** Called after every card answer. Safe to call any number of times. */
    async onAnswer(userId: number): Promise<MosaicAward> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { timezone: true },
        });
        if (!user?.timezone)
            return { status: "timezone_required", newPieces: [], piecesEarned: 0, completed: false };
        return this.retry(() =>
            this.prisma.$transaction((tx) => this.evaluateTx(tx, userId, user.timezone), {
                maxWait: 5000,
                timeout: 15000,
            }),
        );
    }

    private async evaluateTx(tx: Tx, userId: number, tz: string): Promise<MosaicAward> {
        const now = this.clock();
        let season = await tx.mosaicSeason.findUnique({
            where: { user_id_artwork_id: { user_id: userId, artwork_id: ART } },
        });
        if (!season) {
            season = await tx.mosaicSeason.create({
                data: {
                    user_id: userId,
                    artwork_id: ART,
                    timezone: tz,
                    start_date: localDateString(now, tz),
                },
            });
        }
        const owned = await this.countPieces(tx, userId);
        if (season.completed_at) {
            // Completed is permanent: nothing can be awarded any more.
            return { status: "completed", newPieces: [], piecesEarned: owned, completed: true };
        }

        const day = seasonDayFor(season.start_date, season.timezone, now);
        const today = localDateString(now, season.timezone);
        const live = await this.liveCounts(tx, userId, today, season.timezone);
        const row = await tx.mosaicDay.findUnique({
            where: { user_id_artwork_id_day_index: { user_id: userId, artwork_id: ART, day_index: day } },
        });
        const ledger = row ? this.toLedger(row) : EMPTY_LEDGER;
        const dailyOwned = await this.countPieces(tx, userId, DAILY_KINDS);
        const plan = planDay(day, live, ledger, dailyOwned);

        const hasActivity =
            plan.ledger.reviews > 0 || plan.ledger.mastered > 0 || plan.ledger.chapterDone;
        if (row || hasActivity) {
            await tx.mosaicDay.upsert({
                where: { user_id_artwork_id_day_index: { user_id: userId, artwork_id: ART, day_index: day } },
                create: { user_id: userId, artwork_id: ART, day_index: day, local_date: today, ...this.ledgerData(plan.ledger) },
                update: { ...this.ledgerData(plan.ledger), updated_at: now },
            });
        }

        const keys: { kind: PieceKind; key: string }[] = [];
        for (let i = 1; i <= plan.scheduledNew; i++)
            keys.push({ kind: "SCHEDULED", key: `sched:d${day}:${ledger.scheduledReleased + i}` });
        for (let i = 1; i <= plan.catchupNew; i++)
            keys.push({ kind: "CATCH_UP", key: `catchup:d${day}:${ledger.catchupReleased + i}` });

        const newPieces = await this.createPieces(tx, userId, owned, keys, day);
        const total = owned + newPieces.length;
        const completed = total >= TOTAL;
        if (completed) await this.markCompleted(tx, season.id, now);
        return {
            status: completed ? "completed" : day > MOSAIC_CONFIG.seasonDays ? "catch_up" : "active",
            newPieces,
            piecesEarned: total,
            completed,
        };
    }

    // ------------------------------------------------------------------ chests
    async claimChest(userId: number, id: string) {
        const m = /^mosaic_chest_(\d+)$/.exec(id);
        const k = m ? Number(m[1]) : 0;
        if (k < 1 || k > CHEST_COUNT) throw new BadRequestException("Unknown chest");
        return this.retry(() =>
            this.prisma.$transaction((tx) => this.claimTx(tx, userId, k), {
                maxWait: 5000,
                timeout: 15000,
            }),
        );
    }

    private async claimTx(tx: Tx, userId: number, k: number) {
        const season = await tx.mosaicSeason.findUnique({
            where: { user_id_artwork_id: { user_id: userId, artwork_id: ART } },
        });
        if (!season) throw new BadRequestException("Your mosaic season has not started yet");
        const now = this.clock();
        const day = seasonDayFor(season.start_date, season.timezone, now);

        if (!season.completed_at) await this.refreshLedgerCounts(tx, userId, season.timezone, day, now);
        const stats = await this.chestStats(tx, userId, day);
        const alreadyClaimed = await tx.userAchievement.findUnique({
            where: { user_id_achievement_id: { user_id: userId, achievement_id: claimKey(k) } },
        });
        if (alreadyClaimed) throw new BadRequestException("Chest already opened");
        const st = chestStatus(k, { day, ...stats, claimed: false });
        if (!st.ready) throw new BadRequestException("Chest is not ready yet");

        try {
            await tx.userAchievement.create({
                data: { user_id: userId, achievement_id: claimKey(k) },
            });
        } catch (e: any) {
            if (e?.code === "P2002") throw new BadRequestException("Chest already opened");
            throw e;
        }

        const owned = await this.countPieces(tx, userId);
        const n = chestPiecesToAward(owned);
        const keys = Array.from({ length: n }, (_, i) => ({
            kind: "CHEST" as PieceKind,
            key: `chest:${k}:${i + 1}`,
        }));
        const newPieces = await this.createPieces(tx, userId, owned, keys, day);
        const total = owned + newPieces.length;
        const completed = total >= TOTAL;
        if (completed && !season.completed_at) await this.markCompleted(tx, season.id, now);

        const before = await tx.user.findUnique({ where: { id: userId } });
        const after = await tx.user.update({
            where: { id: userId },
            data: { xp: { increment: MOSAIC_CONFIG.chest.xp } },
        });
        const levelAfter = getLevelInfo(after.xp).level;
        const leveledUp = levelAfter > getLevelInfo(before.xp).level;
        return {
            xp: MOSAIC_CONFIG.chest.xp,
            leveledUp,
            newLevel: leveledUp ? levelAfter : undefined,
            mosaic: {
                status: (completed ? "completed" : "active") as MosaicStatus,
                newPieces,
                piecesEarned: total,
                completed,
                piecesAwarded: newPieces.length,
                capped: newPieces.length < MOSAIC_CONFIG.chest.pieces,
                reason: newPieces.length === 0 ? "artwork_complete" : undefined,
            },
        };
    }

    // ------------------------------------------------------------------ reveal ack
    async revealPieces(userId: number, pieceIds: number[]) {
        const ids = (pieceIds ?? []).filter((n) => Number.isInteger(n)).slice(0, TOTAL);
        const r = await this.prisma.mosaicPiece.updateMany({
            where: { user_id: userId, artwork_id: ART, piece_id: { in: ids }, revealed_at: null },
            data: { revealed_at: this.clock() },
        });
        return { revealed: r.count };
    }

    // ------------------------------------------------------------------ read-only state
    async getState(userId: number) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { timezone: true },
        });
        const base = {
            artworkId: ART,
            totalPieces: TOTAL,
            seasonDays: MOSAIC_CONFIG.seasonDays,
            timezone: user?.timezone ?? null,
        };
        const idle = (status: MosaicStatus) => ({
            ...base,
            status,
            seasonDay: 0,
            daysRemaining: MOSAIC_CONFIG.seasonDays,
            piecesEarned: 0,
            piecesRemaining: TOTAL,
            backlog: 0,
            pieces: [],
            today: null,
            chests: this.chestList(1, 0, 0, new Set()),
        });
        if (!user?.timezone) return idle("timezone_required");

        const season = await this.prisma.mosaicSeason.findUnique({
            where: { user_id_artwork_id: { user_id: userId, artwork_id: ART } },
        });
        if (!season) return idle("not_started");

        const now = this.clock();
        const tz = season.timezone;
        const day = seasonDayFor(season.start_date, tz, now);
        const today = localDateString(now, tz);
        const pieces = await this.prisma.mosaicPiece.findMany({
            where: { user_id: userId, artwork_id: ART },
            orderBy: { slot: "asc" },
        });
        const dailyOwned = pieces.filter((p) => p.kind !== "CHEST").length;
        const live = await this.liveCounts(this.prisma, userId, today, tz);
        const row = await this.prisma.mosaicDay.findUnique({
            where: { user_id_artwork_id_day_index: { user_id: userId, artwork_id: ART, day_index: day } },
        });
        const ledger = row ? this.toLedger(row) : EMPTY_LEDGER;
        const merged: DayCounts = {
            reviews: Math.max(ledger.reviews, live.reviews),
            mastered: Math.max(ledger.mastered, live.mastered),
            chapterDone: ledger.chapterDone || live.chapterDone,
        };
        const steps = stepState(merged);
        const s = MOSAIC_CONFIG.steps;
        const rows = await this.prisma.mosaicDay.findMany({
            where: { user_id: userId, artwork_id: ART, day_index: { not: day } },
            select: { reviews: true },
        });
        const activeDays = rows.filter((r) => isActiveDay(r.reviews)).length + (isActiveDay(merged.reviews) ? 1 : 0);
        const totalReviews = rows.reduce((a, r) => a + r.reviews, 0) + merged.reviews;
        const claims = await this.prisma.userAchievement.findMany({
            where: { user_id: userId, achievement_id: { startsWith: "claim:mosaic_chest_" } },
            select: { achievement_id: true },
        });
        const claimed = new Set(claims.map((c) => c.achievement_id));
        const completed = !!season.completed_at;
        return {
            ...base,
            timezone: tz,
            status: (completed ? "completed" : day > MOSAIC_CONFIG.seasonDays ? "catch_up" : "active") as MosaicStatus,
            seasonDay: day,
            daysRemaining: Math.max(0, MOSAIC_CONFIG.seasonDays - day),
            piecesEarned: pieces.length,
            piecesRemaining: TOTAL - pieces.length,
            backlog: Math.max(0, cumulativeAllowance(day) - dailyOwned),
            pieces: pieces.map((p) => ({
                pieceId: p.piece_id,
                slot: p.slot,
                kind: p.kind,
                earnedAt: p.earned_at,
                revealed: p.revealed_at !== null,
            })),
            today: {
                day,
                allowance: dailyAllowance(day),
                stepsDone: steps.done,
                scheduledReleased: ledger.scheduledReleased,
                catchupReleased: ledger.catchupReleased,
                catchupCap: catchUpCap(day),
                steps: {
                    study: { done: steps.study, progress: Math.min(merged.reviews, s.studyReviews), target: s.studyReviews },
                    mastery: { done: steps.mastery, progress: Math.min(merged.mastered, s.masteryCards), target: s.masteryCards },
                    challenge: {
                        done: steps.challenge,
                        progress: Math.min(merged.reviews, s.challengeReviews),
                        target: s.challengeReviews,
                        chapterDone: merged.chapterDone,
                    },
                },
            },
            chests: this.chestList(day, activeDays, totalReviews, claimed),
        };
    }

    private chestList(day: number, activeDays: number, totalReviews: number, claimed: Set<string>) {
        return Array.from({ length: CHEST_COUNT }, (_, i) => {
            const k = i + 1;
            const st = chestStatus(k, { day, activeDays, totalReviews, claimed: claimed.has(claimKey(k)) });
            return {
                id: chestId(k),
                index: k,
                unlockDay: st.unlockDay,
                pieces: MOSAIC_CONFIG.chest.pieces,
                xp: MOSAIC_CONFIG.chest.xp,
                reachedDay: st.reachedDay,
                ready: st.ready,
                claimed: st.claimed,
                activeDays: { have: Math.min(activeDays, st.activeDaysNeed), need: st.activeDaysNeed },
                reviews: { have: Math.min(totalReviews, st.reviewsNeed), need: st.reviewsNeed },
            };
        });
    }

    // ------------------------------------------------------------------ helpers
    private async createPieces(
        tx: Tx,
        userId: number,
        ownedNow: number,
        keys: { kind: PieceKind; key: string }[],
        seasonDay: number,
    ): Promise<AwardedPiece[]> {
        const out: AwardedPiece[] = [];
        let slot = ownedNow;
        for (const { kind, key } of keys) {
            slot += 1;
            if (slot > TOTAL) break; // hard cap: never a 101st piece
            const pieceId = REVEAL_ORDER[slot - 1];
            await tx.mosaicPiece.create({
                data: { user_id: userId, artwork_id: ART, slot, piece_id: pieceId, kind, source_key: key, season_day: seasonDay },
            });
            out.push({ pieceId, slot, kind, seasonDay });
        }
        return out;
    }

    private countPieces(tx: Tx | PrismaService, userId: number, kinds?: PieceKind[]) {
        return tx.mosaicPiece.count({
            where: { user_id: userId, artwork_id: ART, ...(kinds ? { kind: { in: kinds } } : {}) },
        });
    }

    private markCompleted(tx: Tx, seasonId: number, at: Date) {
        return tx.mosaicSeason.updateMany({
            where: { id: seasonId, completed_at: null },
            data: { completed_at: at },
        });
    }

    private async liveCounts(
        db: Tx | PrismaService,
        userId: number,
        localDate: string,
        tz: string,
    ): Promise<DayCounts> {
        const { start, end } = localDayBoundsUtc(localDate, tz);
        const range = { gte: start, lt: end };
        const reviews = await db.cardAnswer.count({ where: { user_id: userId, updated_at: range } });
        const mastered = await db.cardAnswer.count({
            where: { user_id: userId, updated_at: range, answer: { in: ["GOOD", "EASY"] } },
        });
        const chapters = await db.activityEvent.count({
            where: { user_id: userId, type: "chapter_completed", created_at: range },
        });
        return { reviews, mastered, chapterDone: chapters > 0 };
    }

    /** Persist today's counters only (no awards). Used before a chest check. */
    private async refreshLedgerCounts(tx: Tx, userId: number, tz: string, day: number, now: Date) {
        const today = localDateString(now, tz);
        const live = await this.liveCounts(tx, userId, today, tz);
        if (live.reviews === 0 && live.mastered === 0 && !live.chapterDone) return;
        const row = await tx.mosaicDay.findUnique({
            where: { user_id_artwork_id_day_index: { user_id: userId, artwork_id: ART, day_index: day } },
        });
        const l = row ? this.toLedger(row) : EMPTY_LEDGER;
        const merged: DayLedger = {
            ...l,
            reviews: Math.max(l.reviews, live.reviews),
            mastered: Math.max(l.mastered, live.mastered),
            chapterDone: l.chapterDone || live.chapterDone,
        };
        await tx.mosaicDay.upsert({
            where: { user_id_artwork_id_day_index: { user_id: userId, artwork_id: ART, day_index: day } },
            create: { user_id: userId, artwork_id: ART, day_index: day, local_date: today, ...this.ledgerData(merged) },
            update: { ...this.ledgerData(merged), updated_at: now },
        });
    }

    private async chestStats(tx: Tx, userId: number, _day: number) {
        const rows = await tx.mosaicDay.findMany({
            where: { user_id: userId, artwork_id: ART },
            select: { reviews: true },
        });
        return {
            activeDays: rows.filter((r) => isActiveDay(r.reviews)).length,
            totalReviews: rows.reduce((a, r) => a + r.reviews, 0),
        };
    }

    private toLedger(r: any): DayLedger {
        return {
            reviews: r.reviews,
            mastered: r.mastered,
            chapterDone: r.chapter_done,
            scheduledReleased: r.scheduled_released,
            catchupReleased: r.catchup_released,
        };
    }

    private ledgerData(l: DayLedger) {
        return {
            reviews: l.reviews,
            mastered: l.mastered,
            chapter_done: l.chapterDone,
            scheduled_released: l.scheduledReleased,
            catchup_released: l.catchupReleased,
        };
    }

    /** Retries a whole transaction on unique-key races / deadlocks (fresh snapshot each time). */
    private async retry<T>(fn: () => Promise<T>): Promise<T> {
        for (let attempt = 1; ; attempt++) {
            try {
                return await fn();
            } catch (e: any) {
                const retriable = e?.code === "P2002" || e?.code === "P2034";
                if (!retriable || attempt >= 8) throw e;
                await new Promise((r) => setTimeout(r, 10 + Math.random() * 40 * attempt));
            }
        }
    }
}

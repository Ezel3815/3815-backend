import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "nestjs-prisma";
import { invalidateHierarchy } from "src/utils/hierarchy-cache";

const FORMAT = "mozaik-cards-backup";
const VERSION = 1;
const CHUNK = 400;

type Fail = { kind: string; id: string | number; reason: string };

function chunks<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

@Injectable()
export class BackupService {
    constructor(private prisma: PrismaService) {}

    /**
     * Read-only snapshot of decks + cards + media rows as plain JSON.
     * By default only admin (official) content; `includePersonal` adds users' own decks.
     * Image/PDF FILES are not inside the JSON (only their names); the files themselves are stored on Cloudinary / in /public.
     * Users' answers/progress are NOT included: they belong to users, not to the content.
     */
    async exportCards(includePersonal: boolean) {
        const decks = await this.prisma.deck.findMany({
            where: includePersonal ? {} : { by_admin: true },
            orderBy: { id: "asc" },
        });
        const deckIds = decks.map((d) => d.id);
        const cards = await this.prisma.card.findMany({
            where: { deck_id: { in: deckIds } },
            orderBy: [{ deck_id: "asc" }, { order: "asc" }],
        });
        const mediaNames = new Set<string>();
        for (const c of cards) {
            for (const n of [c.front_image_name, c.back_image_name, c.document_name])
                if (n) mediaNames.add(n);
        }
        const media = await this.prisma.media.findMany({
            where: { name: { in: [...mediaNames] } },
        });

        return {
            format: FORMAT,
            version: VERSION,
            exported_at: new Date().toISOString(),
            scope: includePersonal ? "all_decks" : "admin_decks",
            counts: { decks: decks.length, cards: cards.length, media: media.length },
            decks: decks.map((d) => ({
                id: d.id,
                title: d.title,
                parent_id: d.parent_id,
                by_admin: d.by_admin,
                type: d.type,
                public: d.public,
                order: d.order,
                created_at: d.created_at,
            })),
            cards: cards.map((c) => ({
                id: c.id,
                order: c.order,
                deck_id: c.deck_id,
                type: c.type,
                data: c.data,
                document_name: c.document_name,
                document_title: c.document_title,
                front_image_name: c.front_image_name,
                back_image_name: c.back_image_name,
                created_at: c.created_at,
            })),
            media: media.map((m) => ({
                name: m.name,
                type: m.type,
                created_at: m.created_at,
            })),
        };
    }

    /**
     * Restores a backup file. NEVER deletes anything.
     *  - default (overwrite=false): only adds what is missing, keeps current edits.
     *  - overwrite=true: also resets existing decks/cards (same id) to the backup's values.
     * Ids are kept, so users' answers and progress stay attached to the same cards.
     * Safe to run twice.
     */
    async restoreCards(payload: any, overwrite: boolean) {
        if (
            !payload ||
            payload.format !== FORMAT ||
            payload.version !== VERSION ||
            !Array.isArray(payload.decks) ||
            !Array.isArray(payload.cards)
        )
            throw new BadRequestException("This is not a Mozaik cards backup file");

        const failed: Fail[] = [];
        const summary = {
            media: { created: 0, existing: 0 },
            decks: { created: 0, updated: 0, existing: 0 },
            cards: { created: 0, updated: 0, existing: 0 },
        };

        // 1) media rows (cards point at them)
        const media: any[] = Array.isArray(payload.media) ? payload.media : [];
        const mediaOk = media.filter((m) => m && typeof m.name === "string" && m.type);
        for (const part of chunks(mediaOk, CHUNK)) {
            const r = await this.prisma.media.createMany({
                data: part.map((m) => ({
                    name: m.name,
                    type: m.type,
                    created_at: m.created_at ? new Date(m.created_at) : undefined,
                })),
                skipDuplicates: true,
            });
            summary.media.created += r.count;
            summary.media.existing += part.length - r.count;
        }

        // 2) decks, parents before children
        const decks: any[] = payload.decks.filter((d: any) => d && Number.isInteger(d.id));
        const deckById = new Map<number, any>(decks.map((d) => [d.id, d]));
        const known = new Set<number>(
            (
                await this.prisma.deck.findMany({
                    where: { id: { in: [...deckById.keys()] } },
                    select: { id: true },
                })
            ).map((d) => d.id),
        );
        const existedBefore = new Set(known);
        const parentIds = decks
            .map((d) => d.parent_id)
            .filter((p) => Number.isInteger(p) && !deckById.has(p));
        for (const p of (
            await this.prisma.deck.findMany({
                where: { id: { in: parentIds } },
                select: { id: true },
            })
        ).map((d) => d.id))
            known.add(p);

        let pending = decks.slice();
        while (pending.length) {
            const next: any[] = [];
            let progressed = false;
            for (const d of pending) {
                const parentOk =
                    d.parent_id == null || known.has(d.parent_id) || d.parent_id === d.id;
                if (!parentOk) {
                    next.push(d);
                    continue;
                }
                const data = {
                    title: String(d.title ?? ""),
                    parent_id: d.parent_id ?? null,
                    by_admin: !!d.by_admin,
                    type: d.type,
                    public: !!d.public,
                    order: Number.isInteger(d.order) ? d.order : 0,
                };
                try {
                    if (existedBefore.has(d.id)) {
                        if (overwrite) {
                            await this.prisma.deck.update({ where: { id: d.id }, data });
                            summary.decks.updated++;
                        } else summary.decks.existing++;
                    } else {
                        await this.prisma.deck.create({
                            data: {
                                id: d.id,
                                ...data,
                                created_at: d.created_at ? new Date(d.created_at) : undefined,
                            },
                        });
                        summary.decks.created++;
                    }
                    known.add(d.id);
                    progressed = true;
                } catch (e: any) {
                    failed.push({ kind: "deck", id: d.id, reason: String(e?.code ?? e?.message ?? e).slice(0, 120) });
                    progressed = true; // handled (as a failure); don't retry forever
                }
            }
            if (!progressed) {
                for (const d of next)
                    failed.push({ kind: "deck", id: d.id, reason: "parent deck not found" });
                break;
            }
            pending = next;
        }

        // 3) cards
        const cards: any[] = payload.cards.filter((c: any) => c && Number.isInteger(c.id));
        for (const part of chunks(cards, CHUNK)) {
            const ids = part.map((c) => c.id);
            const have = new Set(
                (
                    await this.prisma.card.findMany({
                        where: { id: { in: ids } },
                        select: { id: true },
                    })
                ).map((c) => c.id),
            );

            // media names that really exist (a missing one would break the insert)
            const wanted = new Set<string>();
            for (const c of part)
                for (const n of [c.front_image_name, c.back_image_name, c.document_name])
                    if (n) wanted.add(n);
            const haveMedia = new Set(
                (
                    await this.prisma.media.findMany({
                        where: { name: { in: [...wanted] } },
                        select: { name: true },
                    })
                ).map((m) => m.name),
            );
            const ref = (n: any) => (n && haveMedia.has(n) ? n : null);

            const mk = (c: any) => ({
                order: Number.isInteger(c.order) ? c.order : 0,
                deck_id: c.deck_id,
                type: c.type,
                data: c.data,
                document_name: ref(c.document_name),
                document_title: c.document_title ?? null,
                front_image_name: ref(c.front_image_name),
                back_image_name: ref(c.back_image_name),
            });

            const deckOk = (c: any) => known.has(c.deck_id);
            for (const c of part.filter((c) => !deckOk(c)))
                failed.push({ kind: "card", id: c.id, reason: "deck not found" });
            const usable = part.filter(deckOk);

            const toCreate = usable.filter((c) => !have.has(c.id));
            if (toCreate.length) {
                try {
                    const r = await this.prisma.card.createMany({
                        data: toCreate.map((c) => ({
                            id: c.id,
                            ...mk(c),
                            created_at: c.created_at ? new Date(c.created_at) : undefined,
                        })),
                        skipDuplicates: true,
                    });
                    summary.cards.created += r.count;
                    if (r.count < toCreate.length)
                        failed.push({
                            kind: "card",
                            id: `${toCreate.length - r.count} cards`,
                            reason: "skipped: an image/document name is already used by another card",
                        });
                } catch {
                    // one bad card must not sink the whole chunk: retry one by one
                    for (const c of toCreate) {
                        try {
                            await this.prisma.card.create({ data: { id: c.id, ...mk(c) } });
                            summary.cards.created++;
                        } catch (e: any) {
                            failed.push({ kind: "card", id: c.id, reason: String(e?.code ?? e?.message ?? e).slice(0, 120) });
                        }
                    }
                }
            }

            const existing = usable.filter((c) => have.has(c.id));
            if (!overwrite) summary.cards.existing += existing.length;
            else
                for (const c of existing) {
                    try {
                        await this.prisma.card.update({ where: { id: c.id }, data: mk(c) });
                        summary.cards.updated++;
                    } catch (e: any) {
                        failed.push({ kind: "card", id: c.id, reason: String(e?.code ?? e?.message ?? e).slice(0, 120) });
                    }
                }
        }

        invalidateHierarchy(); // everyone's deck list may have changed
        return { ok: true, overwrite, summary, failed: failed.slice(0, 50), failed_count: failed.length };
    }
}

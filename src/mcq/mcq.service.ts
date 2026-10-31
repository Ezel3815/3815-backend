import {
    ConflictException,
    Injectable,
    NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "crypto";
import { PrismaService } from "nestjs-prisma";
import { GenerateBadRequestException } from "src/exception/bad-request.exception";
import {
    CollectionValue,
    QuestionValue,
    Result,
    SubjectValue,
    validateCollection,
    validateQuestion,
    validateSubject,
} from "./mcq.validation";

export interface ImportIssue {
    kind: "payload" | "subject" | "collection" | "question";
    id: string | null;
    message: string;
}

export const MAX_IMPORT_RECORDS = 5000;
const CHUNK = 100;
const CATALOG_CACHE_MS = 60_000;

/** Unwraps a validation result or throws HTTP 400 with every problem listed. */
function must<T>(r: Result<T>): T {
    if (r.ok === false) {
        GenerateBadRequestException(r.errors);
        throw new Error("unreachable");
    }
    return r.value;
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function idOf(raw: unknown): string | null {
    return isObj(raw) && typeof raw.id === "string" ? raw.id : null;
}

function chunks<T>(list: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}

/** Maps a validated question to Prisma column values (only the supplied fields). */
function questionColumns(v: QuestionValue): any {
    const data: any = {};
    for (const k of ["text", "explanation", "exam_label", "source", "order", "published"] as const) {
        if (v[k] !== undefined) data[k] = v[k];
    }
    if (v.options !== undefined) data.options = v.options as unknown as Prisma.InputJsonValue;
    if (v.correct !== undefined) data.correct = v.correct as unknown as Prisma.InputJsonValue;
    if (v.key_points !== undefined) {
        data.key_points =
            v.key_points === null || v.key_points.length === 0
                ? Prisma.DbNull
                : (v.key_points as unknown as Prisma.InputJsonValue);
    }
    return data;
}

@Injectable()
export class McqService {
    private cache: { at: number; etag: string; body: any } | null = null;

    constructor(private readonly prisma: PrismaService) {}

    private invalidate() {
        this.cache = null;
    }

    // ------------------------------------------------------------------
    // Student side
    // ------------------------------------------------------------------

    /**
     * Everything a student can see: published subjects, their published
     * collections and published questions. Unpublished content (and content
     * under an unpublished parent) is never included.
     * Cached for a minute and invalidated on every admin write.
     */
    async catalog(): Promise<{ etag: string; body: any }> {
        if (this.cache && Date.now() - this.cache.at < CATALOG_CACHE_MS) {
            return this.cache;
        }
        const [subjects, collections, questions] = await Promise.all([
            this.prisma.mcqSubject.findMany({
                where: { published: true },
                orderBy: [{ order: "asc" }, { created_at: "asc" }, { id: "asc" }],
            }),
            this.prisma.mcqCollection.findMany({
                where: { published: true, subject: { published: true } },
                orderBy: [{ order: "asc" }, { created_at: "asc" }, { id: "asc" }],
            }),
            this.prisma.mcqQuestion.findMany({
                where: {
                    published: true,
                    collection: { published: true, subject: { published: true } },
                },
                orderBy: [
                    { collection_id: "asc" },
                    { order: "asc" },
                    { created_at: "asc" },
                    { id: "asc" },
                ],
            }),
        ]);

        const body = {
            subjects: subjects.map((s: any) => ({
                id: s.id,
                name: s.name,
                name_en: s.name_en ?? null,
                order: s.order,
            })),
            collections: collections.map((c: any) => ({
                id: c.id,
                subject_id: c.subject_id,
                title: c.title,
                title_en: c.title_en ?? null,
                order: c.order,
            })),
            questions: questions.map((q: any) => ({
                id: q.id,
                subject_id: q.subject_id,
                collection_id: q.collection_id,
                text: q.text,
                options: q.options,
                correct: q.correct,
                explanation: q.explanation ?? null,
                key_points: q.key_points ?? [],
                exam_label: q.exam_label ?? null,
                source: q.source ?? null,
            })),
        };
        const etag = `"${createHash("md5").update(JSON.stringify(body)).digest("hex")}"`;
        this.cache = { at: Date.now(), etag, body };
        return this.cache;
    }

    // ------------------------------------------------------------------
    // Admin: subjects
    // ------------------------------------------------------------------

    listSubjects() {
        return this.prisma.mcqSubject.findMany({
            orderBy: [{ order: "asc" }, { created_at: "asc" }, { id: "asc" }],
            include: { _count: { select: { collections: true, questions: true } } },
        });
    }

    async createSubject(body: unknown) {
        const v = must(validateSubject(body));
        const id = v.id ?? randomUUID();
        if (await this.prisma.mcqSubject.findUnique({ where: { id } })) {
            throw new ConflictException(`Subject "${id}" already exists`);
        }
        let order = v.order;
        if (order === undefined) {
            const agg = await this.prisma.mcqSubject.aggregate({ _max: { order: true } });
            order = (agg._max.order ?? 0) + 1;
        }
        const row = await this.prisma.mcqSubject.create({
            data: {
                id,
                name: v.name!,
                name_en: v.name_en ?? null,
                order,
                published: v.published ?? true,
            },
        });
        this.invalidate();
        return row;
    }

    async updateSubject(id: string, body: unknown) {
        const v = must(validateSubject(body, { partial: true }));
        if (v.id !== undefined && v.id !== id) {
            GenerateBadRequestException(["id cannot be changed"]);
        }
        await this.requireSubject(id);
        const { id: _ignored, ...data } = v;
        const row = await this.prisma.mcqSubject.update({ where: { id }, data });
        this.invalidate();
        return row;
    }

    async deleteSubject(id: string, force: boolean) {
        const s: any = await this.prisma.mcqSubject.findUnique({
            where: { id },
            include: { _count: { select: { collections: true, questions: true } } },
        });
        if (!s) throw new NotFoundException("Subject not found");
        const { collections, questions } = s._count;
        if (!force && (collections > 0 || questions > 0)) {
            throw new ConflictException(
                `Subject has ${collections} collection(s) and ${questions} question(s). ` +
                    `Pass force=true to delete them as well.`,
            );
        }
        await this.prisma.mcqSubject.delete({ where: { id } });
        this.invalidate();
        return { deleted: true, collections, questions };
    }

    private async requireSubject(id: string) {
        const s = await this.prisma.mcqSubject.findUnique({ where: { id } });
        if (!s) throw new NotFoundException("Subject not found");
        return s;
    }

    // ------------------------------------------------------------------
    // Admin: collections
    // ------------------------------------------------------------------

    listCollections(subjectId?: string) {
        return this.prisma.mcqCollection.findMany({
            where: subjectId ? { subject_id: subjectId } : undefined,
            orderBy: [{ subject_id: "asc" }, { order: "asc" }, { created_at: "asc" }, { id: "asc" }],
            include: { _count: { select: { questions: true } } },
        });
    }

    async createCollection(body: unknown) {
        const v = must(validateCollection(body));
        await this.requireSubject(v.subject_id!);
        const id = v.id ?? randomUUID();
        if (await this.prisma.mcqCollection.findUnique({ where: { id } })) {
            throw new ConflictException(`Collection "${id}" already exists`);
        }
        let order = v.order;
        if (order === undefined) {
            const agg = await this.prisma.mcqCollection.aggregate({
                where: { subject_id: v.subject_id },
                _max: { order: true },
            });
            order = (agg._max.order ?? 0) + 1;
        }
        const row = await this.prisma.mcqCollection.create({
            data: {
                id,
                subject_id: v.subject_id!,
                title: v.title!,
                title_en: v.title_en ?? null,
                order,
                published: v.published ?? true,
            },
        });
        this.invalidate();
        return row;
    }

    async updateCollection(id: string, body: unknown) {
        const v = must(validateCollection(body, { partial: true }));
        if (v.id !== undefined && v.id !== id) {
            GenerateBadRequestException(["id cannot be changed"]);
        }
        const existing = await this.prisma.mcqCollection.findUnique({ where: { id } });
        if (!existing) throw new NotFoundException("Collection not found");
        const { id: _ignored, ...data } = v;

        if (data.subject_id !== undefined && data.subject_id !== existing.subject_id) {
            await this.requireSubject(data.subject_id);
            // Keep every question's subject in step with its collection.
            const [row] = await this.prisma.$transaction([
                this.prisma.mcqCollection.update({ where: { id }, data }),
                this.prisma.mcqQuestion.updateMany({
                    where: { collection_id: id },
                    data: { subject_id: data.subject_id },
                }),
            ]);
            this.invalidate();
            return row;
        }
        const row = await this.prisma.mcqCollection.update({ where: { id }, data });
        this.invalidate();
        return row;
    }

    async deleteCollection(id: string, force: boolean) {
        const c: any = await this.prisma.mcqCollection.findUnique({
            where: { id },
            include: { _count: { select: { questions: true } } },
        });
        if (!c) throw new NotFoundException("Collection not found");
        const questions = c._count.questions;
        if (!force && questions > 0) {
            throw new ConflictException(
                `Collection has ${questions} question(s). Pass force=true to delete them as well.`,
            );
        }
        await this.prisma.mcqCollection.delete({ where: { id } });
        this.invalidate();
        return { deleted: true, questions };
    }

    // ------------------------------------------------------------------
    // Admin: questions
    // ------------------------------------------------------------------

    async listQuestions(f: {
        subject_id?: string;
        collection_id?: string;
        search?: string;
        published?: boolean;
        page?: number;
        limit?: number;
    }) {
        const page = Math.max(1, Math.floor(f.page ?? 1));
        const limit = Math.min(200, Math.max(1, Math.floor(f.limit ?? 50)));
        const where: any = {};
        if (f.subject_id) where.subject_id = f.subject_id;
        if (f.collection_id) where.collection_id = f.collection_id;
        if (f.published !== undefined) where.published = f.published;
        if (f.search && f.search.trim()) where.text = { contains: f.search.trim() };
        const [items, total] = await Promise.all([
            this.prisma.mcqQuestion.findMany({
                where,
                orderBy: [{ collection_id: "asc" }, { order: "asc" }, { created_at: "asc" }, { id: "asc" }],
                skip: (page - 1) * limit,
                take: limit,
            }),
            this.prisma.mcqQuestion.count({ where }),
        ]);
        return { items, total, page, limit };
    }

    async getQuestion(id: string) {
        const q = await this.prisma.mcqQuestion.findUnique({ where: { id } });
        if (!q) throw new NotFoundException("Question not found");
        return q;
    }

    async createQuestion(body: unknown) {
        const v = must(validateQuestion(body));
        const col = await this.prisma.mcqCollection.findUnique({
            where: { id: v.collection_id! },
        });
        if (!col) throw new NotFoundException("Collection not found");
        if (v.subject_id !== undefined && v.subject_id !== col.subject_id) {
            GenerateBadRequestException(["subject_id does not match the collection's subject"]);
        }
        const id = v.id ?? randomUUID();
        if (await this.prisma.mcqQuestion.findUnique({ where: { id } })) {
            throw new ConflictException(`Question "${id}" already exists`);
        }
        let order = v.order;
        if (order === undefined) {
            const agg = await this.prisma.mcqQuestion.aggregate({
                where: { collection_id: col.id },
                _max: { order: true },
            });
            order = (agg._max.order ?? 0) + 1;
        }
        const row = await this.prisma.mcqQuestion.create({
            data: {
                id,
                subject_id: col.subject_id,
                collection_id: col.id,
                published: true,
                ...questionColumns({ ...v, order }),
            },
        });
        this.invalidate();
        return row;
    }

    async updateQuestion(id: string, body: unknown) {
        const v = must(validateQuestion(body, { partial: true }));
        if (v.id !== undefined && v.id !== id) {
            GenerateBadRequestException(["id cannot be changed"]);
        }
        const existing = await this.prisma.mcqQuestion.findUnique({ where: { id } });
        if (!existing) throw new NotFoundException("Question not found");

        const data: any = questionColumns(v);
        if (v.collection_id !== undefined && v.collection_id !== existing.collection_id) {
            const col = await this.prisma.mcqCollection.findUnique({
                where: { id: v.collection_id },
            });
            if (!col) throw new NotFoundException("Collection not found");
            if (v.subject_id !== undefined && v.subject_id !== col.subject_id) {
                GenerateBadRequestException(["subject_id does not match the collection's subject"]);
            }
            data.collection_id = col.id;
            data.subject_id = col.subject_id;
        } else if (v.subject_id !== undefined && v.subject_id !== existing.subject_id) {
            GenerateBadRequestException([
                "subject_id cannot be changed on its own; move the question by changing collection_id",
            ]);
        }
        const row = await this.prisma.mcqQuestion.update({ where: { id }, data });
        this.invalidate();
        return row;
    }

    async deleteQuestion(id: string) {
        const existing = await this.prisma.mcqQuestion.findUnique({ where: { id } });
        if (!existing) throw new NotFoundException("Question not found");
        await this.prisma.mcqQuestion.delete({ where: { id } });
        this.invalidate();
        return { deleted: true };
    }

    // ------------------------------------------------------------------
    // Admin: export / import (same JSON shape both ways)
    // ------------------------------------------------------------------

    async exportBank(subjectId?: string) {
        const subjects = await this.prisma.mcqSubject.findMany({
            where: subjectId ? { id: subjectId } : undefined,
            orderBy: [{ order: "asc" }, { created_at: "asc" }, { id: "asc" }],
        });
        const ids = subjects.map((s: any) => s.id);
        const [collections, questions] = await Promise.all([
            this.prisma.mcqCollection.findMany({
                where: { subject_id: { in: ids } },
                orderBy: [{ subject_id: "asc" }, { order: "asc" }, { created_at: "asc" }, { id: "asc" }],
            }),
            this.prisma.mcqQuestion.findMany({
                where: { subject_id: { in: ids } },
                orderBy: [{ collection_id: "asc" }, { order: "asc" }, { created_at: "asc" }, { id: "asc" }],
            }),
        ]);
        return {
            subjects: subjects.map((s: any) => ({
                id: s.id, name: s.name, name_en: s.name_en, order: s.order, published: s.published,
            })),
            collections: collections.map((c: any) => ({
                id: c.id, subject_id: c.subject_id, title: c.title, title_en: c.title_en,
                order: c.order, published: c.published,
            })),
            questions: questions.map((q: any) => ({
                id: q.id, subject_id: q.subject_id, collection_id: q.collection_id, text: q.text,
                options: q.options, correct: q.correct, explanation: q.explanation,
                key_points: q.key_points ?? [], exam_label: q.exam_label, source: q.source,
                order: q.order, published: q.published,
            })),
        };
    }

    /** Publishes (or hides) every question of the given collections, except the ids in `exceptIds` (questions that still need an admin check). */
    async publishImported(collectionIds: string[], exceptIds: string[] = [], published = true) {
        if (!collectionIds.length) return { questions: 0 };
        const q = await this.prisma.mcqQuestion.updateMany({
            where: { collection_id: { in: collectionIds }, ...(exceptIds.length ? { id: { notIn: exceptIds } } : {}) },
            data: { published },
        });
        if (published) await this.prisma.mcqCollection.updateMany({ where: { id: { in: collectionIds } }, data: { published: true } });
        this.invalidate();
        return { questions: q.count };
    }


    /**
     * Idempotent bulk import (re-running the same file changes nothing).
     * Records are upserted by id. Invalid records are NEVER dropped silently:
     * each one is returned in `issues` with the reason.
     *  - dryRun: validate and report, write nothing.
     *  - strict: if any issue exists, write nothing.
     * Writes happen in chunks, so a crash mid-way can leave a partial import;
     * simply run it again.
     */
    async importBank(body: unknown, opts: { dryRun: boolean; strict: boolean }) {
        const issues: ImportIssue[] = [];
        if (!isObj(body)) {
            GenerateBadRequestException(["body must be an object with subjects / collections / questions"]);
            throw new Error("unreachable");
        }
        const list = (key: "subjects" | "collections" | "questions"): unknown[] => {
            const v = (body as any)[key];
            if (v === undefined) return [];
            if (!Array.isArray(v)) {
                issues.push({ kind: "payload", id: null, message: `${key} must be an array` });
                return [];
            }
            return v;
        };
        const rawS = list("subjects");
        const rawC = list("collections");
        const rawQ = list("questions");
        const received = { subjects: rawS.length, collections: rawC.length, questions: rawQ.length };
        if (rawS.length + rawC.length + rawQ.length > MAX_IMPORT_RECORDS) {
            GenerateBadRequestException([
                `too many records in one request (max ${MAX_IMPORT_RECORDS}); split the file`,
            ]);
        }

        // ---- subjects
        const subjects = new Map<string, SubjectValue>();
        for (const raw of rawS) {
            const r = validateSubject(raw, { requireId: true });
            if (r.ok === false) {
                issues.push({ kind: "subject", id: idOf(raw), message: r.errors.join("; ") });
            } else if (subjects.has(r.value.id!)) {
                issues.push({ kind: "subject", id: r.value.id!, message: "duplicate id in file (first one kept)" });
            } else {
                subjects.set(r.value.id!, r.value);
            }
        }

        // ---- collections
        const collections = new Map<string, CollectionValue>();
        const parsedC: CollectionValue[] = [];
        for (const raw of rawC) {
            const r = validateCollection(raw, { requireId: true });
            if (r.ok === false) {
                issues.push({ kind: "collection", id: idOf(raw), message: r.errors.join("; ") });
            } else if (collections.has(r.value.id!)) {
                issues.push({ kind: "collection", id: r.value.id!, message: "duplicate id in file (first one kept)" });
            } else {
                collections.set(r.value.id!, r.value);
                parsedC.push(r.value);
            }
        }
        // Parents must be in the file or already in the database.
        const neededSubjects = [...new Set(parsedC.map((c) => c.subject_id!))].filter((id) => !subjects.has(id));
        const dbSubjects = new Set<string>(
            neededSubjects.length
                ? (await this.prisma.mcqSubject.findMany({ where: { id: { in: neededSubjects } }, select: { id: true } })).map((x: any) => x.id)
                : [],
        );
        for (const c of parsedC) {
            if (!subjects.has(c.subject_id!) && !dbSubjects.has(c.subject_id!)) {
                collections.delete(c.id!);
                issues.push({ kind: "collection", id: c.id!, message: `subject "${c.subject_id}" is neither in the file nor in the database` });
            }
        }

        // ---- questions
        const dbCollectionSubject = new Map<string, string>();
        const neededCollections = [
            ...new Set(
                rawQ
                    .map((q) => (isObj(q) && typeof q.collection_id === "string" ? q.collection_id : null))
                    .filter((x): x is string => !!x && !collections.has(x)),
            ),
        ];
        if (neededCollections.length) {
            const rows = await this.prisma.mcqCollection.findMany({
                where: { id: { in: neededCollections } },
                select: { id: true, subject_id: true },
            });
            for (const r of rows as any[]) dbCollectionSubject.set(r.id, r.subject_id);
        }
        const questions = new Map<string, QuestionValue & { subject_id: string }>();
        for (const raw of rawQ) {
            const r = validateQuestion(raw, { requireId: true });
            if (r.ok === false) {
                issues.push({ kind: "question", id: idOf(raw), message: r.errors.join("; ") });
                continue;
            }
            const q = r.value;
            if (questions.has(q.id!)) {
                issues.push({ kind: "question", id: q.id!, message: "duplicate id in file (first one kept)" });
                continue;
            }
            const subjectId =
                collections.get(q.collection_id!)?.subject_id ?? dbCollectionSubject.get(q.collection_id!);
            if (!subjectId) {
                issues.push({ kind: "question", id: q.id!, message: `collection "${q.collection_id}" is neither a valid collection in the file nor in the database` });
                continue;
            }
            if (q.subject_id !== undefined && q.subject_id !== subjectId) {
                issues.push({ kind: "question", id: q.id!, message: `subject_id "${q.subject_id}" does not match the collection's subject "${subjectId}"` });
                continue;
            }
            questions.set(q.id!, { ...q, subject_id: subjectId });
        }

        // ---- what already exists (created vs updated)
        const existing = async (model: "mcqSubject" | "mcqCollection" | "mcqQuestion", ids: string[]) =>
            new Set<string>(
                ids.length
                    ? ((await (this.prisma as any)[model].findMany({ where: { id: { in: ids } }, select: { id: true } })) as any[]).map((x) => x.id)
                    : [],
            );
        const [exS, exC, exQ] = await Promise.all([
            existing("mcqSubject", [...subjects.keys()]),
            existing("mcqCollection", [...collections.keys()]),
            existing("mcqQuestion", [...questions.keys()]),
        ]);
        const summary = {
            created: {
                subjects: [...subjects.keys()].filter((i) => !exS.has(i)).length,
                collections: [...collections.keys()].filter((i) => !exC.has(i)).length,
                questions: [...questions.keys()].filter((i) => !exQ.has(i)).length,
            },
            updated: {
                subjects: [...subjects.keys()].filter((i) => exS.has(i)).length,
                collections: [...collections.keys()].filter((i) => exC.has(i)).length,
                questions: [...questions.keys()].filter((i) => exQ.has(i)).length,
            },
        };
        const base = {
            dry_run: opts.dryRun,
            strict: opts.strict,
            received,
            ...summary,
            skipped: issues.filter((i) => i.kind !== "payload").length,
            issues,
        };
        if (opts.dryRun) return { ...base, applied: false };
        if (opts.strict && issues.length > 0) return { ...base, applied: false };

        // ---- default `order` for NEW records without one: append in file order
        const subjectBase = (await this.prisma.mcqSubject.aggregate({ _max: { order: true } }))._max.order ?? 0;
        const colBase = new Map<string, number>();
        const qBase = new Map<string, number>();
        const colSubjects = [...new Set([...collections.values()].map((c) => c.subject_id!))];
        if (colSubjects.length) {
            const g: any[] = await (this.prisma.mcqCollection as any).groupBy({
                by: ["subject_id"], where: { subject_id: { in: colSubjects } }, _max: { order: true },
            });
            for (const r of g) colBase.set(r.subject_id, r._max.order ?? 0);
        }
        const qCols = [...new Set([...questions.values()].map((q) => q.collection_id!))];
        if (qCols.length) {
            const g: any[] = await (this.prisma.mcqQuestion as any).groupBy({
                by: ["collection_id"], where: { collection_id: { in: qCols } }, _max: { order: true },
            });
            for (const r of g) qBase.set(r.collection_id, r._max.order ?? 0);
        }

        let sSeq = 0;
        const subjectOps = [...subjects.values()].map((s) => {
            const isNew = !exS.has(s.id!);
            const order = s.order ?? (isNew ? subjectBase + ++sSeq : undefined);
            const { id, ...rest } = s;
            return this.prisma.mcqSubject.upsert({
                where: { id: id! },
                create: { id: id!, name: s.name!, name_en: s.name_en ?? null, order: order ?? 0, published: s.published ?? true },
                update: { ...rest, ...(order !== undefined && s.order !== undefined ? { order } : {}) },
            });
        });
        const cSeq = new Map<string, number>();
        const collectionOps = [...collections.values()].map((c) => {
            const isNew = !exC.has(c.id!);
            const n = (cSeq.get(c.subject_id!) ?? 0) + (isNew && c.order === undefined ? 1 : 0);
            cSeq.set(c.subject_id!, n);
            const order = c.order ?? (isNew ? (colBase.get(c.subject_id!) ?? 0) + n : undefined);
            const { id, ...rest } = c;
            return this.prisma.mcqCollection.upsert({
                where: { id: id! },
                create: { id: id!, subject_id: c.subject_id!, title: c.title!, title_en: c.title_en ?? null, order: order ?? 0, published: c.published ?? true },
                update: rest,
            });
        });
        const qSeq = new Map<string, number>();
        const questionOps = [...questions.values()].map((q) => {
            const isNew = !exQ.has(q.id!);
            const n = (qSeq.get(q.collection_id!) ?? 0) + (isNew && q.order === undefined ? 1 : 0);
            qSeq.set(q.collection_id!, n);
            const order = q.order ?? (isNew ? (qBase.get(q.collection_id!) ?? 0) + n : undefined);
            const cols = questionColumns({ ...q, ...(order !== undefined ? { order } : {}) });
            return this.prisma.mcqQuestion.upsert({
                where: { id: q.id! },
                create: { id: q.id!, subject_id: q.subject_id, collection_id: q.collection_id!, published: true, ...cols },
                update: { subject_id: q.subject_id, collection_id: q.collection_id!, ...cols },
            });
        });

        for (const ops of [subjectOps, collectionOps, questionOps]) {
            for (const part of chunks(ops as any[], CHUNK)) {
                await this.prisma.$transaction(part);
            }
        }
        this.invalidate();
        return { ...base, applied: true };
    }
}

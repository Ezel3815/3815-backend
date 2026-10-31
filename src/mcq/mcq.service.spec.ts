import { McqService } from "./mcq.service";

/** Tiny in-memory stand-in for the Prisma calls McqService uses. */
function makeFakePrisma() {
    const t: Record<string, Map<string, any>> = {
        mcqSubject: new Map(),
        mcqCollection: new Map(),
        mcqQuestion: new Map(),
    };
    let clock = 0;
    const now = () => new Date(1700000000000 + ++clock);

    const match = (row: any, where: any): boolean => {
        if (!where) return true;
        for (const [k, cond] of Object.entries<any>(where)) {
            if (cond === undefined) continue;
            if (k === "subject" || k === "collection") {
                const parent = k === "subject"
                    ? t.mcqSubject.get(row.subject_id)
                    : t.mcqCollection.get(row.collection_id);
                if (!parent || !match(parent, cond)) return false;
            } else if (cond !== null && typeof cond === "object" && "in" in cond) {
                if (!cond.in.includes(row[k])) return false;
            } else if (cond !== null && typeof cond === "object" && "contains" in cond) {
                if (!String(row[k]).includes(cond.contains)) return false;
            } else if (row[k] !== cond) return false;
        }
        return true;
    };
    const sort = (rows: any[], orderBy: any[] = []) =>
        [...rows].sort((a, b) => {
            for (const o of orderBy) {
                const [k, dir] = Object.entries<any>(o)[0];
                if (a[k] < b[k]) return dir === "asc" ? -1 : 1;
                if (a[k] > b[k]) return dir === "asc" ? 1 : -1;
            }
            return 0;
        });
    // The real Prisma.DbNull writes SQL NULL; the test shim represents it as "DbNull".
    const nullify = (row: any) => {
        for (const k of Object.keys(row)) if (row[k] === "DbNull") row[k] = null;
        return row;
    };
    const withCount = (name: string, row: any, include: any) => {
        if (!include?._count) return row;
        const c: any = {};
        const sel = include._count.select;
        if (sel.collections) c.collections = [...t.mcqCollection.values()].filter((x) => x.subject_id === row.id).length;
        if (sel.questions) {
            c.questions = [...t.mcqQuestion.values()].filter((x) =>
                name === "mcqSubject" ? x.subject_id === row.id : x.collection_id === row.id,
            ).length;
        }
        return { ...row, _count: c };
    };
    const cascadeDelete = (name: string, id: string) => {
        t[name].delete(id);
        if (name === "mcqSubject") {
            for (const c of [...t.mcqCollection.values()]) if (c.subject_id === id) cascadeDelete("mcqCollection", c.id);
            for (const q of [...t.mcqQuestion.values()]) if (q.subject_id === id) t.mcqQuestion.delete(q.id);
        }
        if (name === "mcqCollection") {
            for (const q of [...t.mcqQuestion.values()]) if (q.collection_id === id) t.mcqQuestion.delete(q.id);
        }
    };

    const model = (name: string, defaults: () => any) => ({
        findMany: async (a: any = {}) => {
            let rows = sort([...t[name].values()].filter((r) => match(r, a.where)), a.orderBy);
            if (a.skip) rows = rows.slice(a.skip);
            if (a.take !== undefined) rows = rows.slice(0, a.take);
            return rows.map((r) => withCount(name, r, a.include));
        },
        findUnique: async (a: any) => {
            const r = t[name].get(a.where.id);
            return r ? withCount(name, r, a.include) : null;
        },
        count: async (a: any = {}) => [...t[name].values()].filter((r) => match(r, a.where)).length,
        create: async (a: any) => {
            const row = nullify({ ...defaults(), ...a.data, created_at: now(), updated_at: now() });
            t[name].set(row.id, row);
            return row;
        },
        update: async (a: any) => {
            const row = nullify({ ...t[name].get(a.where.id), ...a.data, updated_at: now() });
            t[name].set(row.id, row);
            return row;
        },
        updateMany: async (a: any) => {
            let n = 0;
            for (const r of t[name].values()) if (match(r, a.where)) { Object.assign(r, a.data); n++; }
            return { count: n };
        },
        upsert: async (a: any) => {
            const cur = t[name].get(a.where.id);
            const row = nullify(cur
                ? { ...cur, ...a.update, updated_at: now() }
                : { ...defaults(), ...a.create, created_at: now(), updated_at: now() });
            t[name].set(row.id, row);
            return row;
        },
        delete: async (a: any) => { cascadeDelete(name, a.where.id); return {}; },
        aggregate: async (a: any = {}) => {
            const rows = [...t[name].values()].filter((r) => match(r, a.where));
            return { _max: { order: rows.length ? Math.max(...rows.map((r) => r.order)) : null } };
        },
        groupBy: async (a: any) => {
            const out = new Map<string, number>();
            for (const r of t[name].values()) {
                if (!match(r, a.where)) continue;
                const k = r[a.by[0]];
                out.set(k, Math.max(out.get(k) ?? 0, r.order));
            }
            return [...out.entries()].map(([k, m]) => ({ [a.by[0]]: k, _max: { order: m } }));
        },
    });

    return {
        mcqSubject: model("mcqSubject", () => ({ order: 0, published: true, name_en: null })),
        mcqCollection: model("mcqCollection", () => ({ order: 0, published: true, title_en: null })),
        mcqQuestion: model("mcqQuestion", () => ({
            order: 0, published: true, explanation: null, key_points: null, exam_label: null, source: null,
        })),
        $transaction: async (ops: Promise<any>[]) => Promise.all(ops),
        _tables: t,
    };
}

const subject = (id = "surgery", extra: any = {}) => ({ id, name: "الجراحة العامة", ...extra });
const collection = (id = "liver", subject_id = "surgery", extra: any = {}) => ({
    id, subject_id, title: "الكبد", ...extra,
});
const question = (id: string, collection_id = "liver", extra: any = {}) => ({
    id, collection_id, text: `سؤال ${id}`,
    options: [{ id: "a", text: "أ" }, { id: "b", text: "ب" }, { id: "c", text: "ج" }],
    correct: ["b"], ...extra,
});

describe("McqService", () => {
    let prisma: ReturnType<typeof makeFakePrisma>;
    let svc: McqService;
    beforeEach(() => {
        prisma = makeFakePrisma();
        svc = new McqService(prisma as any);
    });

    async function seed() {
        await svc.createSubject(subject());
        await svc.createCollection(collection());
        await svc.createQuestion(question("q1"));
        await svc.createQuestion(question("q2", "liver", { explanation: "شرح" }));
    }

    it("student catalog returns published content in the app's shape", async () => {
        await seed();
        const { body, etag } = await svc.catalog();
        expect(etag.startsWith('"')).toBe(true);
        expect(body.subjects).toHaveLength(1);
        expect(body.collections).toHaveLength(1);
        expect(body.questions).toHaveLength(2);
        const q = body.questions[1];
        expect(q.id).toBe("q2");
        expect(q.subject_id).toBe("surgery"); // derived from the collection
        expect(q.correct).toEqual(["b"]);
        expect(q.explanation).toBe("شرح");
        expect(body.questions[0].explanation).toBeNull();
        expect(body.questions[0].key_points).toEqual([]);
    });

    it("hides unpublished questions, collections and subjects (and their children)", async () => {
        await seed();
        await svc.updateQuestion("q1", { published: false });
        let c = (await svc.catalog()).body;
        expect(c.questions).toHaveLength(1);
        await svc.updateCollection("liver", { published: false });
        c = (await svc.catalog()).body;
        expect(c.collections).toHaveLength(0);
        expect(c.questions).toHaveLength(0);
        await svc.updateCollection("liver", { published: true });
        await svc.updateSubject("surgery", { published: false });
        c = (await svc.catalog()).body;
        expect(c.subjects).toHaveLength(0);
        expect(c.collections).toHaveLength(0);
        expect(c.questions).toHaveLength(0);
    });

    it("every admin write invalidates the cached catalog and changes the etag", async () => {
        await seed();
        const a = await svc.catalog();
        const same = await svc.catalog();
        expect(same.etag).toBe(a.etag);
        await svc.createQuestion(question("q3"));
        const b = await svc.catalog();
        expect(b.etag).not.toBe(a.etag);
        expect(b.body.questions).toHaveLength(3);
    });

    it("new questions get the next order in their collection", async () => {
        await seed();
        const q3 = await svc.createQuestion(question("q3"));
        expect(q3.order).toBe(3);
    });

    it("rejects an invalid answer key and duplicate ids", async () => {
        await seed();
        await expect(svc.createQuestion(question("bad", "liver", { correct: ["zzz"] }))).rejects.toThrow();
        await expect(svc.createQuestion(question("q1"))).rejects.toThrow();
        await expect(svc.createQuestion(question("x", "no-such-collection"))).rejects.toThrow();
    });

    it("refuses to change options without correct, but accepts both together", async () => {
        await seed();
        await expect(
            svc.updateQuestion("q1", { options: [{ id: "a", text: "x" }, { id: "b", text: "y" }] }),
        ).rejects.toThrow();
        const r: any = await svc.updateQuestion("q1", {
            options: [{ id: "a", text: "x" }, { id: "b", text: "y" }],
            correct: ["a"],
        });
        expect(r.correct).toEqual(["a"]);
    });

    it("moving a collection to another subject moves its questions' subject too", async () => {
        await seed();
        await svc.createSubject(subject("medicine", { name: "الباطنة" }));
        await svc.updateCollection("liver", { subject_id: "medicine" });
        const q: any = await svc.getQuestion("q1");
        expect(q.subject_id).toBe("medicine");
    });

    it("deleting a non-empty subject needs force and then cascades", async () => {
        await seed();
        await expect(svc.deleteSubject("surgery", false)).rejects.toThrow();
        const r = await svc.deleteSubject("surgery", true);
        expect(r.questions).toBe(2);
        expect((await svc.catalog()).body.questions).toHaveLength(0);
    });

    describe("import", () => {
        const file = () => ({
            subjects: [{ id: "surgery", name: "الجراحة العامة", name_en: "General Surgery" }],
            collections: [{ id: "liver", subject_id: "surgery", title: "الكبد" }],
            questions: [question("a1"), question("a2", "liver", { exam_label: "دورة 2023" }), question("a3")],
        });

        it("dry run reports what would happen and writes nothing", async () => {
            const r: any = await svc.importBank(file(), { dryRun: true, strict: false });
            expect(r.applied).toBe(false);
            expect(r.created.questions).toBe(3);
            expect(prisma._tables.mcqQuestion.size).toBe(0);
        });

        it("imports in file order and re-running changes nothing (idempotent)", async () => {
            const first: any = await svc.importBank(file(), { dryRun: false, strict: false });
            expect(first.applied).toBe(true);
            expect(first.created.questions).toBe(3);
            const orders = [...prisma._tables.mcqQuestion.values()].map((q) => [q.id, q.order]);
            expect(orders).toEqual([["a1", 1], ["a2", 2], ["a3", 3]]);
            const etag1 = (await svc.catalog()).etag;

            const again: any = await svc.importBank(file(), { dryRun: false, strict: false });
            expect(again.created.questions).toBe(0);
            expect(again.updated.questions).toBe(3);
            expect(prisma._tables.mcqQuestion.size).toBe(3);
            expect((await svc.catalog()).etag).toBe(etag1);
        });

        it("reports every malformed record instead of dropping it silently", async () => {
            const f = file();
            f.questions.push(
                question("bad-key", "liver", { correct: ["zzz"] }),
                question("orphan", "no-such-collection"),
                question("a1"), // duplicate id in file
                { id: "no-text", collection_id: "liver" } as any,
            );
            const r: any = await svc.importBank(f, { dryRun: false, strict: false });
            expect(r.applied).toBe(true);
            expect(r.created.questions).toBe(3);
            expect(r.skipped).toBe(4);
            const byId = Object.fromEntries(r.issues.map((i: any) => [i.id, i.message]));
            expect(byId["bad-key"]).toContain("unknown option");
            expect(byId["orphan"]).toContain("collection");
            expect(byId["a1"]).toContain("duplicate");
            expect(byId["no-text"]).toContain("text");
        });

        it("strict mode writes nothing when any record is invalid", async () => {
            const f = file();
            f.questions.push(question("bad", "liver", { correct: [] }));
            const r: any = await svc.importBank(f, { dryRun: false, strict: true });
            expect(r.applied).toBe(false);
            expect(r.issues).toHaveLength(1);
            expect(prisma._tables.mcqQuestion.size).toBe(0);
        });

        it("a question whose collection was rejected is reported, not imported", async () => {
            const f: any = file();
            f.collections.push({ id: "ghost", subject_id: "nope", title: "x" });
            f.questions.push(question("g1", "ghost"));
            const r: any = await svc.importBank(f, { dryRun: false, strict: false });
            expect(r.issues.map((i: any) => i.id)).toContain("ghost");
            expect(r.issues.map((i: any) => i.id)).toContain("g1");
            expect(prisma._tables.mcqQuestion.has("g1")).toBe(false);
        });

        it("can attach new questions to a collection that already exists in the database", async () => {
            await svc.importBank(file(), { dryRun: false, strict: false });
            const r: any = await svc.importBank(
                { questions: [question("more1"), question("more2")] },
                { dryRun: false, strict: false },
            );
            expect(r.created.questions).toBe(2);
            expect(prisma._tables.mcqQuestion.get("more1").order).toBe(4);
            expect(prisma._tables.mcqQuestion.get("more1").subject_id).toBe("surgery");
        });

        it("a re-import updates changed text and keeps the existing order", async () => {
            await svc.importBank(file(), { dryRun: false, strict: false });
            const f = file();
            f.questions[1] = question("a2", "liver", { text: "نص معدّل" });
            await svc.importBank(f, { dryRun: false, strict: false });
            const row = prisma._tables.mcqQuestion.get("a2");
            expect(row.text).toBe("نص معدّل");
            expect(row.order).toBe(2);
        });

        it("rejects a non-object body and oversized files", async () => {
            await expect(svc.importBank("nope", { dryRun: true, strict: false })).rejects.toThrow();
            const huge = { questions: Array.from({ length: 5001 }, (_, i) => question(`h${i}`)) };
            await expect(svc.importBank(huge, { dryRun: true, strict: false })).rejects.toThrow();
        });
    });

    it("export round-trips into import", async () => {
        await seed();
        const out = await svc.exportBank();
        const prisma2 = makeFakePrisma();
        const svc2 = new McqService(prisma2 as any);
        const r: any = await svc2.importBank(out, { dryRun: false, strict: true });
        expect(r.applied).toBe(true);
        expect(r.created.questions).toBe(2);
        expect((await svc2.catalog()).body).toEqual((await svc.catalog()).body);
    });
});

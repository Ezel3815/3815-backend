import { Injectable, Logger, NotFoundException, OnApplicationBootstrap } from "@nestjs/common";
import { CardType, MediaType, User } from "@prisma/client";
import { PrismaService } from "nestjs-prisma";
import { DecksService } from "src/services/decks.service";
import { DecksCardsService } from "src/services/decks-cards.service";
import { MediaService } from "src/services/media.service";
import { EmailService } from "src/services/email.service";
import { invalidateHierarchy } from "src/utils/hierarchy-cache";
import { Cfg, Doctor, Engine, IO, Lecture } from "./engine";
import { KeyPool, PoolExhausted, PoolStopped, Role, keyLabel } from "./key-pool";

const MAX_TITLE = 15; // the backend refuses deck names longer than this
const CHUNK = 4 * 1024 * 1024;
const uid = () => Math.random().toString(36).slice(2, 9);
const emptyRep = () => ({ fixes: [], deleted: [], pictures: [], noPicture: [], lowConf: [] });

@Injectable()
export class PipelineService implements OnApplicationBootstrap {
    private readonly logger = new Logger("Pipeline");
    private pool = KeyPool.fromEnv();
    private busy = false;
    private waitMailed = new Set<number>();
    private currentId: number | null = null;
    private retry?: NodeJS.Timeout;

    constructor(
        private prisma: PrismaService,
        private decks: DecksService,
        private cards: DecksCardsService,
        private media: MediaService,
        private email: EmailService,
    ) {}

    // After a restart/redeploy of the free server, unfinished jobs continue by themselves.
    onApplicationBootstrap() {
        this.loadKeys();
        // scheduled jobs: checked every minute (they are stored in the database, so a restart does not lose them)
        setInterval(async () => {
            try {
                const due = (await this.prisma.pipelineJob.findMany({ where: { status: "scheduled" }, select: { id: true, state: true } })).filter((j) => ((j.state as any)?.runAt ?? 0) <= Date.now());
                if (!due.length) return;
                await this.prisma.pipelineJob.updateMany({ where: { id: { in: due.map((j) => j.id) } }, data: { status: "queued", message: null } });
                this.kick();
            } catch {}
        }, 60_000);
        setTimeout(async () => {
            await this.prisma.pipelineJob.updateMany({ where: { status: { in: ["running", "waiting"] } }, data: { status: "queued" } }).catch(() => {});
            this.kick();
        }, 20000);
    }

    private dbIds = new Map<string, number>();
    private async loadKeys() {
        try {
            for (const r of await this.prisma.pipelineKey.findMany()) { this.pool.addKeys(r.key, r.role as Role); this.dbIds.set(r.key, r.id); }
        } catch (e: any) { this.logger.error("keys: " + String(e?.message || e)); }
    }
    keys() {
        return this.pool.keys.map((k) => ({ id: this.dbIds.get(k.key) ?? null, label: keyLabel(k.key), role: k.role, state: this.pool.state(k), reason: k.reason, ok: k.ok }));
    }
    /** Keys added from the dashboard are saved in the database, so they survive restarts. */
    async addKeys(text: string, role: Role) {
        const r: Role = (["any", "write", "review", "pics"] as Role[]).includes(role) ? role : "any";
        const list = [...new Set(String(text || "").split(/[\n,;\s]+/).map((x) => x.trim()).filter((x) => x.length > 8))].slice(0, 100);
        const added = this.pool.addKeys(list.join("\n"), r);
        for (const key of list) {
            const row = await this.prisma.pipelineKey.upsert({ where: { key }, update: { role: r }, create: { key, role: r } });
            this.dbIds.set(key, row.id);
        }
        this.kickWaiting();
        return { added, total: this.pool.keys.length };
    }
    async removeKey(id: number) {
        const row = await this.prisma.pipelineKey.findUnique({ where: { id } });
        if (!row) throw new NotFoundException("Key not found");
        await this.prisma.pipelineKey.delete({ where: { id } });
        this.dbIds.delete(row.key);
        const k = this.pool.keys.find((x) => x.key === row.key); if (k) this.pool.remove(k);
        return { ok: true };
    }
    /** Gives every key another chance (cooling or marked invalid), and wakes up a waiting job. */
    reviveKeys() { this.pool.reviveAll(); this.kickWaiting(); return { ok: true }; }
    private async kickWaiting() {
        await this.prisma.pipelineJob.updateMany({ where: { status: "waiting" }, data: { status: "queued" } }).catch(() => {});
        this.kick();
    }

    // ---------------- jobs ----------------
    async create(user: User, body: { title?: string; config: Cfg; doctors: any[] }) {
        const doctors: Doctor[] = (body.doctors ?? []).map((d) => ({
            id: String(d.id || uid()), name: String(d.name || "").trim(), deckId: null,
            lectures: (d.lectures ?? []).map((l: any): Lecture => ({
                id: String(l.id || uid()), name: String(l.name || "").trim(), fileName: String(l.fileName || ""), size: Number(l.size) || 0,
                status: "waiting for file", msg: "", progress: "", stage: "queued", drafts: [], saved: [], rejected: [], deckId: null, extracted: false, rep: emptyRep(),
            })),
        }));
        const c = body.config;
        const config: Cfg = {
            subject: String(c.subject || "").trim(), yearId: Number(c.yearId), instructions: String(c.instructions || ""),
            cardCount: c.cardCount ? Math.floor(Number(c.cardCount)) : null, passes: Math.max(0, Math.min(2, Number(c.passes ?? 1))),
            colorize: c.colorize !== false, mainColor: c.mainColor || "#009688", hiColor: c.hiColor || "#673ab7", hideNew: !!c.hideNew,
            threshold: Number(c.threshold) || 85, deleteThreshold: Number(c.deleteThreshold) || 92,
            polishWithFile: c.polishWithFile !== false, cutout: c.cutout !== false,
        };
        const job = await this.prisma.pipelineJob.create({
            data: { title: body.title || `${config.subject}`, user_id: user.id, config: config as any, state: { subjectId: null, doctors, createdAt: Date.now() } as any, log: [] },
        });
        return { id: job.id };
    }

    async saveFile(jobId: number, lectureId: string, file: Express.Multer.File) {
        const job = await this.get(jobId);
        const st: any = job.state;
        const l = (st.doctors as Doctor[]).flatMap((d) => d.lectures).find((x) => x.id === lectureId);
        if (!l) throw new NotFoundException("Lecture not found");
        await this.prisma.pipelineFile.deleteMany({ where: { job_id: jobId, lecture_id: lectureId } });
        for (let i = 0, seq = 0; i < file.buffer.length; i += CHUNK, seq++)
            await this.prisma.pipelineFile.create({ data: { job_id: jobId, lecture_id: lectureId, seq, mime: file.mimetype, data: file.buffer.subarray(i, i + CHUNK) } });
        l.status = "queued"; l.fileName = file.originalname; l.size = file.size;
        await this.prisma.pipelineJob.update({ where: { id: jobId }, data: { state: st } });
        return { ok: true };
    }

    private async loadFile(jobId: number, lectureId: string) {
        const rows = await this.prisma.pipelineFile.findMany({ where: { job_id: jobId, lecture_id: lectureId }, orderBy: { seq: "asc" } });
        if (!rows.length) return null;
        return { base64: Buffer.concat(rows.map((r) => Buffer.from(r.data))).toString("base64"), mime: rows[0].mime };
    }

    async get(id: number) {
        const j = await this.prisma.pipelineJob.findUnique({ where: { id } });
        if (!j) throw new NotFoundException("Job not found");
        return j;
    }

    async list() {
        const jobs = await this.prisma.pipelineJob.findMany({ orderBy: { id: "desc" }, take: 30, select: { id: true, title: true, status: true, message: true, state: true, created_at: true, updated_at: true } });
        return jobs.map((j) => ({ ...j, ...this.summary(j.state), state: undefined }));
    }

    private summary(state: any) {
        const runAt = state?.runAt ?? null;
        const ls: Lecture[] = (state?.doctors ?? []).flatMap((d: Doctor) => d.lectures);
        return {
            runAt,
            lectures: ls.map((l) => ({ id: l.id, name: l.name, status: l.status, stage: l.stage, msg: l.msg, progress: l.progress, cards: l.saved.length })),
            done: ls.filter((l) => l.stage === "done").length, total: ls.length, cards: ls.reduce((n, l) => n + l.saved.length, 0),
        };
    }

    async detail(id: number) {
        const j = await this.get(id);
        return { id: j.id, title: j.title, status: j.status, message: j.message, log: j.log, report: j.report, ...this.summary(j.state), updated_at: j.updated_at };
    }

    async start(id: number, runAt?: number) {
        const j = await this.get(id);
        const st: any = j.state;
        if (runAt && runAt > Date.now() + 30_000) {
            st.runAt = runAt;
            await this.prisma.pipelineJob.update({ where: { id }, data: { status: "scheduled", message: `Scheduled for ${new Date(runAt).toISOString()}`, state: st } });
            return { ok: true, scheduled: true };
        }
        delete st.runAt;
        for (const l of (st.doctors as Doctor[]).flatMap((d) => d.lectures)) if (l.status === "error") { l.status = l.stage === "written" ? "written" : "queued"; l.msg = ""; }
        await this.prisma.pipelineJob.update({ where: { id }, data: { status: "queued", message: null, state: st } });
        this.kick();
        return { ok: true };
    }

    async pause(id: number) {
        if (this.currentId === id) this.pool.stopped = true;
        else await this.prisma.pipelineJob.updateMany({ where: { id, status: { in: ["queued", "waiting", "scheduled"] } }, data: { status: "paused" } });
        return { ok: true };
    }

    async remove(id: number) {
        if (this.currentId === id) this.pool.stopped = true;
        await this.prisma.pipelineJob.delete({ where: { id } });
        return { ok: true };
    }

    // ---------------- runner (one job at a time: the free server is small) ----------------
    kick() {
        if (this.busy) return;
        this.busy = true;
        (async () => {
            try {
                for (;;) {
                    const job = await this.prisma.pipelineJob.findFirst({ where: { status: { in: ["queued", "running"] } }, orderBy: { id: "asc" } });
                    if (!job) break;
                    const again = await this.runJob(job.id);
                    if (!again) break;
                }
            } catch (e: any) { this.logger.error(String(e?.message || e)); }
            finally { this.busy = false; this.currentId = null; }
        })();
    }

    private scheduleRetry() {
        clearTimeout(this.retry);
        this.retry = setTimeout(async () => {
            await this.prisma.pipelineJob.updateMany({ where: { status: "waiting" }, data: { status: "queued" } });
            this.kick();
        }, 20 * 60 * 1000);
    }

    private async ensureDeck(user: User, title: string, type: "PACKAGE_DECK" | "CARDS_DECK", parentId: number, order: number, visible: boolean): Promise<number> {
        const t = title.trim();
        const where = { parent_id: parentId, by_admin: true, title: t } as any;
        const hit = await this.prisma.deck.findFirst({ where });
        if (hit) {
            // subject + doctor are packages, chapters are card decks: never reuse a deck of the wrong kind
            if (hit.type !== type) throw new Error(`"${t}" already exists here as a ${hit.type === "PACKAGE_DECK" ? "package (folder)" : "card deck"}, but it must be a ${type === "PACKAGE_DECK" ? "package (folder)" : "card deck"}. Rename or delete the old one, then press Resume.`);
            return hit.id;
        }
        if (t.length > MAX_TITLE) throw new Error(`"${t}" is ${t.length} characters. Deck names can be at most ${MAX_TITLE}.`);
        await this.decks.create(user, { title: t, type, parent_id: parentId, public: false, visible, order } as any);
        const made = await this.prisma.deck.findFirst({ where: { ...where, type }, orderBy: { id: "desc" } });
        if (!made) throw new Error(`Created "${t}" but could not find it as a ${type}`);
        return made.id;
    }

    private checkedDecks = new Set<number>();
    /** Cards may only be added to a card deck (chapter), never to a package (subject / doctor). */
    private async assertCardsDeck(deckId: number) {
        if (this.checkedDecks.has(deckId)) return;
        const d = await this.prisma.deck.findUnique({ where: { id: deckId }, select: { type: true } });
        if (d?.type !== "CARDS_DECK") throw new Error("Cards can only be added to a card deck (chapter), not to a package.");
        this.checkedDecks.add(deckId);
    }

    private async runJob(id: number): Promise<boolean> {
        const job = await this.get(id);
        const cfg = job.config as unknown as Cfg;
        const st: any = job.state;
        const doctors: Doctor[] = st.doctors;
        const user = await this.prisma.user.findUnique({ where: { id: job.user_id } });
        if (!user) { await this.finish(id, "error", "The admin who started this job no longer exists.", st); return true; }
        this.currentId = id; this.pool.stopped = false;
        const log: string[] = Array.isArray(job.log) ? (job.log as string[]) : [];
        let timer: NodeJS.Timeout | undefined;
        const persist = () => {
            clearTimeout(timer);
            timer = setTimeout(() => this.prisma.pipelineJob.update({ where: { id }, data: { state: st, log: log.slice(0, 150) } }).catch(() => {}), 1500);
        };
        const io: IO = {
            log: (m) => { log.unshift(`${new Date().toISOString().slice(11, 19)}  ${m}`); persist(); },
            persist,
            saveCard: async (deckId, q, a) => (await this.assertCardsDeck(deckId), await this.cards.create(user, deckId, { type: CardType.BASIC, data: { front: { text: q, size: 14, align: "center" }, back: { text: a, size: 14, align: "center" } } } as any) as any)?.id ?? 0,
            loadCards: async (deckId) => {
                const rows = await this.prisma.card.findMany({ where: { deck_id: deckId }, orderBy: { order: "asc" } });
                return rows.map((r) => {
                    let data: any = r.data;
                    for (let n = 0; n < 3 && typeof data === "string"; n++) { try { data = JSON.parse(data); } catch { data = null; } }
                    return { id: r.id, type: r.type, data, hasPic: !!(r.front_image_name || r.back_image_name) || r.type === CardType.OCCLUSION };
                });
            },
            updateCard: async (deckId, cid, type, data) => { await this.cards.update(user, deckId, cid, { type, data } as any); },
            deleteCard: async (deckId, cid) => { await this.cards.delete(undefined, deckId, cid); },
            attach: async (cid, png) => {
                const m = await this.media.create({ buffer: png, originalname: `card_${cid}.png`, mimetype: "image/png", size: png.length } as any, MediaType.IMAGE);
                await this.prisma.card.update({ where: { id: cid }, data: { back_image_name: m.name } });
            },
        };
        await this.prisma.pipelineJob.update({ where: { id }, data: { status: "running", message: null } });
        try {
            if (!this.pool.keys.some((k) => !k.dead)) throw new Error("No AI key on the server. Add keys in Pipeline > AI keys.");
            io.log("Preparing folders…");
            st.subjectId = await this.ensureDeck(user, cfg.subject, "PACKAGE_DECK", cfg.yearId, 0, !cfg.hideNew);
            let di = 0;
            for (const d of doctors) {
                di++;
                if (!d.name || !d.lectures.length) continue;
                d.deckId ??= await this.ensureDeck(user, d.name, "PACKAGE_DECK", st.subjectId, di, !cfg.hideNew);
                for (const l of d.lectures) if (l.deckId == null && l.name) l.deckId = await this.ensureDeck(user, l.name, "CARDS_DECK", d.deckId!, d.lectures.indexOf(l) + 1, !cfg.hideNew);
            }
            persist();
            const engine = new Engine(this.pool, cfg, io);
            for (const d of doctors) for (const l of d.lectures) {
                if (l.stage === "done" || l.deckId == null) continue;
                if (this.pool.stopped) throw new PoolStopped("Paused");
                const src = await this.loadFile(id, l.id);
                if (!src) { l.status = "error"; l.msg = "The file was not uploaded."; continue; }
                try {
                    await engine.processLecture(d, l, src);
                    await this.prisma.pipelineFile.deleteMany({ where: { job_id: id, lecture_id: l.id } }); // free database space
                } catch (e: any) {
                    if (e instanceof PoolStopped || e instanceof PoolExhausted) throw e;
                    l.status = "error"; l.msg = String(e?.message || e); io.log(`${l.name}: ${l.msg}`);
                }
                persist();
            }
            if (cfg.hideNew && doctors.every((d) => d.lectures.every((l) => l.stage === "done"))) {
                const ids = [st.subjectId, ...doctors.flatMap((d) => [d.deckId, ...d.lectures.map((l) => l.deckId)])].filter((x) => x != null);
                await this.prisma.deck.updateMany({ where: { id: { in: ids } }, data: { visible: true } }); invalidateHierarchy();
            }
            const failed = doctors.some((d) => d.lectures.some((l) => l.stage !== "done"));
            clearTimeout(timer);
            const doneMsg = failed ? "Finished with some lectures failed: see the report, then press Resume." : "Finished.";
            const rep = this.buildReport(job.title, st, cfg);
            await this.finish(id, "done", doneMsg, st, log, rep);
            this.waitMailed.delete(id);
            await this.notify(user, job.title, "done", doneMsg, rep);
            return true;
        } catch (e: any) {
            clearTimeout(timer);
            if (e instanceof PoolStopped) { await this.finish(id, "paused", "Paused.", st, log); return false; }
            if (e instanceof PoolExhausted) {
                const m = `${e.message} It continues by itself in about 20 minutes. Add more keys in Pipeline > AI keys to speed it up.`;
                await this.finish(id, "waiting", m, st, log); this.scheduleRetry();
                if (!this.waitMailed.has(id)) { this.waitMailed.add(id); await this.notify(user, job.title, "waiting", m); } // one email per job, not one every retry
                return false;
            }
            const rep = this.buildReport(job.title, st, cfg), em = String(e?.message || e);
            await this.finish(id, "error", em, st, log, rep);
            await this.notify(user, job.title, "error", em, rep);
            return true;
        } finally { this.pool.stopped = false; }
    }

    /** Email to the admin who started the job: finished, stopped by an error, or waiting for AI keys. */
    private async notify(user: User, title: string, status: string, message: string, report?: any) {
        try {
            if (!user.email) return;
            const t = report?.totals;
            const lines = [`Job: ${title}`, `Status: ${status}`, message];
            if (t) lines.push("", `Lectures: ${t.lecturesDone}/${t.lectures}`, `Cards: ${t.cards}`, `Fixed: ${t.fixed}`, `Deleted: ${t.deleted}`, `Pictures added: ${t.pictures}`, `Need your attention: ${t.attention}`);
            for (const l of report?.lectures ?? []) if (l.error) lines.push(`Problem in "${l.name}": ${l.error}`);
            const url = process.env.DASHBOARD_URL; lines.push("", url ? `Open the report: ${url.replace(/\/$/, "")}/pipeline` : "Open the dashboard > Pipeline to see the full report.");
            const subject = status === "done" ? `✅ Pipeline finished: ${title}` : status === "waiting" ? `⏸ Pipeline waiting for AI keys: ${title}` : `⚠️ Pipeline stopped: ${title}`;
            await this.email.notify(user.email, subject, lines.join("\n"));
        } catch {}
    }

    private async finish(id: number, status: string, message: string, state: any, log?: string[], report?: any) {
        await this.prisma.pipelineJob.update({ where: { id }, data: { status, message, state, ...(log ? { log: log.slice(0, 150) } : {}), ...(report ? { report } : {}) } }).catch(() => {});
    }

    private buildReport(title: string, st: any, cfg: Cfg) {
        const ls = (st.doctors as Doctor[]).flatMap((d) => d.lectures.map((l) => ({ d, l })));
        const sum = (f: (l: Lecture) => number) => ls.reduce((n, { l }) => n + f(l), 0);
        return {
            title, subject: cfg.subject, finishedAt: new Date().toISOString(), startedAt: new Date(st.createdAt || Date.now()).toISOString(),
            settings: { threshold: cfg.threshold, deleteThreshold: cfg.deleteThreshold, passes: cfg.passes, checkedAgainstFile: cfg.polishWithFile },
            totals: {
                lectures: ls.length, lecturesDone: ls.filter(({ l }) => l.stage === "done").length, cards: sum((l) => l.saved.length),
                fixed: sum((l) => l.rep?.fixes?.length ?? 0), deleted: sum((l) => l.rep?.deleted?.length ?? 0),
                pictures: sum((l) => l.rep?.pictures?.length ?? 0), noPicture: sum((l) => l.rep?.noPicture?.length ?? 0), attention: sum((l) => l.rep?.lowConf?.length ?? 0),
            },
            lectures: ls.map(({ d, l }) => ({ doctor: d.name, name: l.name, status: l.stage === "done" ? "done" : l.status, error: l.stage === "done" ? "" : l.msg, cards: l.saved.length, ...l.rep })),
            keys: this.keys(),
        };
    }
}

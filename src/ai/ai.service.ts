import { HttpException, Injectable } from "@nestjs/common";
import { CardType, User } from "@prisma/client";
import { PrismaService } from "nestjs-prisma";
import { GenerateBadRequestException } from "src/exception/bad-request.exception";
import { geminiJson } from "src/pipeline/gemini-json";
import { KeyPool, PoolExhausted, canSeePictures } from "src/pipeline/key-pool";
import { cleanCardHtml } from "src/pipeline/card-html";
import { QuizService } from "./quiz.service";
import sharp = require("sharp");
import { invalidateHierarchy } from "src/utils/hierarchy-cache";

export type AiMode = "flashcards" | "mcq";

// Free users: FREE_TRIES scans per rolling WINDOW_H hours. Subscribers: up to SUB_DAILY_CAP per day (fair use).
const FREE_TRIES = Number(process.env.AI_FREE_TRIES ?? 3);
const WINDOW_H = Number(process.env.AI_FREE_WINDOW_HOURS ?? 6);
const SUB_DAILY_CAP = Number(process.env.AI_SUB_DAILY_CAP ?? 100);
const HOUR = 3600e3;
const PLAN_DAYS = { MONTHLY: 30, YEARLY: 365 } as const;

@Injectable()
export class AiService {
    // Own pool so user scans never compete with the admin pipeline. Keys: AI_KEYS_SCAN, else GEMINI_API_KEYS / AI_KEYS.
    private pool = (() => {
        const p = new KeyPool();
        const extra = process.env.AI_KEYS_SCAN || process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY;
        if (extra) p.addKeys(extra, "any");
        return p;
    })();
    private readonly MODEL = process.env.AI_SCAN_MODEL || "gemini-3.5-flash";

    constructor(private prisma: PrismaService, private quizzes: QuizService) {}

    // ---------- quota ----------
    async status(userId: number) {
        const now = Date.now();
        const sub = await this.prisma.aiSubscription.findUnique({ where: { user_id: userId } });
        const premium = !!sub && sub.expires_at.getTime() > now;
        if (premium) {
            const used = await this.prisma.aiUsage.count({ where: { user_id: userId, created_at: { gte: new Date(now - 24 * HOUR) } } });
            return {
                premium: true, plan: sub!.plan, expires_at: sub!.expires_at,
                can_use: used < SUB_DAILY_CAP, remaining: Math.max(0, SUB_DAILY_CAP - used), limit: SUB_DAILY_CAP, next_available_at: null as Date | null,
            };
        }
        const recent = await this.prisma.aiUsage.findMany({
            where: { user_id: userId, created_at: { gte: new Date(now - WINDOW_H * HOUR) } },
            orderBy: { created_at: "asc" }, select: { created_at: true },
        });
        const remaining = Math.max(0, FREE_TRIES - recent.length);
        // rolling window: the oldest try frees up WINDOW_H hours after it was used
        const next = remaining > 0 ? null : new Date(recent[recent.length - FREE_TRIES].created_at.getTime() + WINDOW_H * HOUR);
        return { premium: false, plan: null, expires_at: null, can_use: remaining > 0, remaining, limit: FREE_TRIES, window_hours: WINDOW_H, next_available_at: next };
    }

    /** Reserves one try BEFORE calling the AI (so parallel requests can't bypass the limit); refunded if the AI fails. */
    private async reserve(userId: number, mode: AiMode): Promise<number> {
        const st = await this.status(userId);
        if (!st.can_use) {
            throw new HttpException({
                statusCode: 402, code: st.premium ? "AI_DAILY_CAP" : "AI_QUOTA_EXCEEDED",
                message: st.premium ? "Daily AI limit reached." : `You used your ${FREE_TRIES} free AI tries. Wait or subscribe.`,
                next_available_at: st.next_available_at, premium_required: !st.premium,
            }, 402);
        }
        const row = await this.prisma.aiUsage.create({ data: { user_id: userId, mode } });
        // re-check after insert: if parallel requests overshot the limit, this one backs out
        const after = await this.status(userId);
        if (!after.premium && after.remaining === 0) {
            const inWin = await this.prisma.aiUsage.count({ where: { user_id: userId, created_at: { gte: new Date(Date.now() - WINDOW_H * HOUR) } } });
            if (inWin > FREE_TRIES) {
                await this.prisma.aiUsage.delete({ where: { id: row.id } });
                throw new HttpException({ statusCode: 402, code: "AI_QUOTA_EXCEEDED", message: "AI quota exceeded.", premium_required: true }, 402);
            }
        }
        return row.id;
    }

    // ---------- scan ----------
    async scan(user: User, files: Express.Multer.File[], opts: { mode: AiMode; count: number; language?: string; instructions?: string; deckId?: number; title?: string; deckTitle?: string }) {
        if (!files?.length) GenerateBadRequestException(["Attach at least one photo."]);
        if (!this.pool.keys.some((k) => !k.dead)) throw new HttpException({ statusCode: 503, message: "AI is not configured on the server." }, 503);
        if (opts.deckId && opts.mode === "flashcards") await this.assertOwnDeck(user.id, opts.deckId);

        const usageId = await this.reserve(user.id, opts.mode);
        try {
            // shrink photos first: far fewer bytes/tokens for the AI = much faster, and 1600px is plenty to read a page
            const imgs = await Promise.all(files.map(async (f) => {
                try {
                    const b = await sharp(f.buffer).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
                    return { base64: b.toString("base64"), mime: "image/jpeg" };
                } catch { return { base64: f.buffer.toString("base64"), mime: f.mimetype }; }
            }));
            const [first, ...rest] = imgs;
            const { data } = await this.pool.run(
                (key) => geminiJson({ apiKey: key, model: this.MODEL, prompt: this.prompt(opts), file: first, files: rest, schema: this.schema(opts.mode), maxTokens: 8192, fast: true }),
                30e3, { only: canSeePictures, onlyMsg: "No key that can read pictures." },
            );
            const items = this.clean(opts.mode, Array.isArray(data) ? data : data?.items ?? []).slice(0, opts.count);
            if (!items.length) throw new HttpException({ statusCode: 422, message: "Couldn't find readable study content in the photo. Try a clearer, closer picture." }, 422);

            // Nothing is saved here: the student reviews the result and chooses Keep or Delete (see keepFlashcards / keepQuiz).
            return { mode: opts.mode, items, quiz_id: null, saved_to_deck: null, saved: 0, status: await this.status(user.id) };
        } catch (e: any) {
            await this.prisma.aiUsage.delete({ where: { id: usageId } }).catch(() => {}); // failed scans don't cost a try
            if (e instanceof HttpException) throw e;
            if (e instanceof PoolExhausted) throw new HttpException({ statusCode: 503, message: "AI is busy right now. Please try again in a minute." }, 503);
            throw new HttpException({ statusCode: 502, message: String(e?.message || "AI request failed.") }, 502);
        }
    }

    private prompt(o: { mode: AiMode; count: number; language?: string; instructions?: string }) {
        const lang = o.language ? `Write in ${o.language}.` : "Write in the same language as the text in the photo.";
        const base = `You are a study assistant. The attached photo(s) show a page of notes or a textbook. Read ALL the text and use ONLY facts that appear in it; never invent content. Skip headers, page numbers and trivia. ${lang}`;
        const extra = o.instructions?.trim() ? `\nExtra instructions from the student: ${o.instructions.trim().slice(0, 500)}` : "";
        if (o.mode === "mcq")
            return `${base}\nCreate up to ${o.count} multiple-choice questions. Each has exactly 4 options, exactly one correct, plausible distractors, and a one-sentence explanation. "correct" is the 0-based index of the right option. Shuffle the position of the correct answer.${extra}\nReturn ONLY JSON: {"items":[{"question":"...","options":["a","b","c","d"],"correct":0,"explanation":"..."}]}`;
        return `${base}\nCreate up to ${o.count} flashcards: one atomic fact per card, a clear question and a short answer.${extra}\nReturn ONLY JSON: {"items":[{"question":"...","answer":"..."}]}`;
    }
    private schema(mode: AiMode) {
        const S = { type: "STRING" };
        const item = mode === "mcq"
            ? { type: "OBJECT", properties: { question: S, options: { type: "ARRAY", items: S }, correct: { type: "INTEGER" }, explanation: S }, required: ["question", "options", "correct"] }
            : { type: "OBJECT", properties: { question: S, answer: S }, required: ["question", "answer"] };
        return { type: "OBJECT", properties: { items: { type: "ARRAY", items: item } }, required: ["items"] };
    }
    private clean(mode: AiMode, raw: any[]) {
        const t = (x: any) => (typeof x === "string" ? x.trim() : "");
        const out: any[] = [];
        for (const r of raw) {
            if (mode === "flashcards") {
                if (t(r?.question) && t(r?.answer)) out.push({ question: t(r.question), answer: t(r.answer) });
            } else {
                const options = (Array.isArray(r?.options) ? r.options : []).map(t).filter(Boolean);
                const correct = Number(r?.correct);
                if (t(r?.question) && options.length >= 2 && Number.isInteger(correct) && correct >= 0 && correct < options.length)
                    out.push({ question: t(r.question), options, correct, explanation: t(r?.explanation) });
            }
        }
        return out;
    }

    /** "Keep" on reviewed flashcards: saves them as normal BASIC cards, into [deckId] or into a new deck named [deckTitle]. */
    async keepFlashcards(user: User, b: { deckId?: number; deckTitle?: string; items: any[] }) {
        const items = this.clean("flashcards", Array.isArray(b.items) ? b.items : []).slice(0, 60);
        if (!items.length) GenerateBadRequestException(["No cards to save."]);
        let deckId = b.deckId ?? null;
        if (deckId) await this.assertOwnDeck(user.id, deckId);
        else deckId = await this.newDeck(user, b.deckTitle || "AI");
        const saved = await this.saveToDeck(deckId, "flashcards", items);
        invalidateHierarchy();
        return { deck_id: deckId, saved };
    }
    async keepQuiz(user: User, b: { title?: string; items: any[] }) {
        const items = this.clean("mcq", Array.isArray(b.items) ? b.items : []).slice(0, 60);
        if (!items.length) GenerateBadRequestException(["No questions to save."]);
        const q = await this.quizzes.create(user.id, b.title || "Quiz", items);
        return { quiz_id: q.id, saved: items.length };
    }

    private async newDeck(user: User, title: string) {
        const deck = await this.prisma.deck.create({ data: { title: title.trim().slice(0, 60) || "AI", type: "CARDS_DECK", by_admin: user.role === "ADMIN", public: false, visible: true } });
        await this.prisma.userDeck.create({ data: { deck_id: deck.id, user_id: user.id, sharable: true, editable: true } });
        invalidateHierarchy();
        return deck.id;
    }

    // ---------- saving into a deck (existing BASIC card format; there is no MCQ card type in the app yet) ----------
    private async assertOwnDeck(userId: number, deckId: number) {
        const ud = await this.prisma.userDeck.findUnique({ where: { user_id_deck_id: { user_id: userId, deck_id: deckId } }, include: { deck: true } });
        if (!ud || !ud.editable || ud.deck.type !== "CARDS_DECK") GenerateBadRequestException(["You can't add cards to this deck."]);
    }
    private async saveToDeck(deckId: number, mode: AiMode, items: any[]) {
        const last = await this.prisma.card.findFirst({ where: { deck_id: deckId }, orderBy: { order: "desc" } });
        let order = last ? last.order : 0;
        const side = (text: string) => ({ text, size: 14, align: "center" });
        const esc = (s: string) => cleanCardHtml(s.replace(/</g, "&lt;"));
        for (const it of items) {
            const front = mode === "mcq" ? `${esc(it.question)}<br>` + it.options.map((o: string, i: number) => `<br>${"ABCDEFGH"[i]}) ${esc(o)}`).join("") : esc(it.question);
            const back = mode === "mcq" ? `<b>${"ABCDEFGH"[it.correct]}) ${esc(it.options[it.correct])}</b>${it.explanation ? "<br>" + esc(it.explanation) : ""}` : esc(it.answer);
            await this.prisma.card.create({ data: { deck_id: deckId, type: CardType.BASIC, order: ++order, data: JSON.stringify({ front: side(front), back: side(back) }) } });
        }
        return items.length;
    }

    // ---------- subscriptions ----------
    /** Extends (or starts) a subscription. Called by admins now, and by the store webhook/receipt check later. */
    async grant(userId: number, plan: "MONTHLY" | "YEARLY", source = "admin", ref?: string) {
        const cur = await this.prisma.aiSubscription.findUnique({ where: { user_id: userId } });
        const base = cur && cur.expires_at.getTime() > Date.now() ? cur.expires_at.getTime() : Date.now();
        const expires_at = new Date(base + PLAN_DAYS[plan] * 24 * HOUR);
        await this.prisma.aiSubscription.upsert({
            where: { user_id: userId }, create: { user_id: userId, plan, expires_at, source, ref }, update: { plan, expires_at, source, ref },
        });
        return this.status(userId);
    }
    async revoke(userId: number) {
        await this.prisma.aiSubscription.deleteMany({ where: { user_id: userId } });
        return this.status(userId);
    }
}

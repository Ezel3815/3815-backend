/* eslint-disable */
// Server-side pipeline engine. The prompts and the card logic are the SAME as the dashboard pages
// "Auto Import" (create cards) and "Auto Polish" (review / fix / duplicates / pictures); only the
// browser parts (localStorage, canvas, background-removal model) were replaced by server code.
import sharp = require("sharp");
import { cleanCardHtml } from "./card-html";
import { geminiJson } from "./gemini-json";
import { KeyPool, PoolExhausted, PoolStopped, isClaudeKey, canSeePictures } from "./key-pool";

export interface Draft { question: string; answer: string; status: string; msg: string }
export interface LRep { fixes: any[]; deleted: any[]; pictures: any[]; noPicture: string[]; lowConf: any[] }
export interface Lecture {
    id: string; name: string; fileName: string; size: number;
    status: string; msg: string; progress: string; stage: "queued" | "written" | "done";
    drafts: Draft[]; saved: { q: string; a: string }[]; rejected: string[];
    deckId: number | null; extracted: boolean; rep: LRep;
}
export interface Doctor { id: string; name: string; deckId: number | null; lectures: Lecture[]; styleText?: string; styleFile?: boolean; styleGuide?: string }
interface Missed { location: string; topic: string; detail: string }
export interface Cfg {
    subject: string; yearId: number; instructions: string; cardCount: number | null; passes: number;
    colorize: boolean; mainColor: string; hiColor: string; hideNew: boolean;
    threshold: number; deleteThreshold: number; pictureThreshold?: number; polishWithFile: boolean; cutout: boolean;
}
export interface IO {
    log(m: string): void; persist(): void;
    saveCard(deckId: number, q: string, a: string): Promise<number>;
    loadCards(deckId: number): Promise<{ id: number; type: string; data: any; hasPic: boolean }[]>;
    updateCard(deckId: number, id: number, type: string, data: any): Promise<void>;
    deleteCard(deckId: number, id: number): Promise<void>;
    attach(cardId: number, png: Buffer): Promise<void>;
}
interface Cand { thumb: string; title: string; src: string; lic: string }
interface PCard { id: number; deckId: number; deck: string; type: string; data: any; q: string; a: string; side: "front" | "back"; noPic: boolean }
type St = "idle" | "working" | "done" | "error";
interface Fix { c: PCard; newQ: string; newA: string; reason: string; conf: number; apply: boolean; st: St; msg: string }
interface Dup { c: PCard; keeper: PCard; reason: string; conf: number; apply: boolean; st: St; msg: string }
interface Rem { c: PCard; reason: string; conf: number; apply: boolean; st: St; msg: string }
interface Img { c: PCard; idea: string; cands: Cand[]; pick: number; reason: string; conf: number; apply: boolean; bg: boolean; st: St; msg: string; preview: string }

const UA = "MozaikPipeline/1.0 (flashcard app; contact: admin)";
const plain = (h: string) => (h ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;|&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
const norm = (h: string) => plain(h).toLowerCase().replace(/[ً-ٰٟ]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const toks = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 1));
const jacc = (a: Set<string>, b: Set<string>) => { if (!a.size && !b.size) return 1; let i = 0; a.forEach((x) => b.has(x) && i++); return i / (a.size + b.size - i); };
const clamp = (n: any) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));


export class Engine {
    readonly MODEL = "gemini-3.5-flash";
    readonly GEMINI = "gemini-3.5-flash";
    readonly JUDGE = "gemini-3.8-flash";
    readonly CLAUDE = "claude-sonnet-5-5";
    private readonly BATCH = 25;
    subject: string; instructions: string; cardCount: number | null; passes: number;
    colorize: boolean; mainColor: string; hiColor: string;
    optDups = true; optQuality = true; optImages = true; optBg: boolean; progress = "";
    fixes: Fix[] = []; dups: Dup[] = []; rems: Rem[] = []; imgs: Img[] = []; noPicture: string[] = [];
    constructor(public pool: KeyPool, public cfg: Cfg, public io: IO) {
        this.subject = cfg.subject; this.instructions = cfg.instructions || ""; this.cardCount = cfg.cardCount; this.passes = cfg.passes;
        this.colorize = cfg.colorize; this.mainColor = cfg.mainColor; this.hiColor = cfg.hiColor; this.optBg = cfg.cutout;
    }
    private say(m: string) { this.io.log(m); }
    private persist() { this.io.persist(); }
    private chk() { if (this.pool.stopped) throw new PoolStopped("Paused"); }

    // ================= from Auto Import =================
    private styleParts(): string[] {
        const out: string[] = [];
        if (this.colorize) out.push(`Formatting: the text of "question" and "answer" is simple HTML. Use ONLY the tags <b>, <i>, <u>, <br> and <span style="color: #rrggbb;">, and keep it valid.
- "question": wrap the whole question in <b>...</b>, with no colour.
- "answer": wrap the whole answer as <span style="color: ${this.mainColor};"><b>...</b></span>.
- Inside the answer, YOU decide which 1-3 words matter most (the actual answer term, a drug or structure name, a key number, a critical qualifier) and wrap only those in <span style="color: ${this.hiColor};">...</span> inside the answer. Never colour the whole answer with that second colour.
- Use only these two colours, ${this.mainColor} and ${this.hiColor}.`);
        if (this.instructions.trim()) out.push(`Extra instructions from the user (follow them, but still return ONLY the JSON in the shape above):\n${this.instructions.trim()}`);
        return out;
    }
    private ctx(d: Doctor, l: Lecture) { return `Context: subject "${this.subject}", lecturer "${d.name}", lecture "${l.name}".`; }
    private readonly BASE = `You are helping build flashcards for a medical-education app from the attached document/image.
Read all the content and extract the important, testable facts as flashcards.
Skip filler text, headers, and anything too trivial to quiz on.
Prefer clear, atomic questions (one fact per card) over broad ones. Take facts from the document only; never invent anything.
Return ONLY a JSON array, no markdown fences, no commentary, in this exact shape:
[ { "question": "...", "answer": "..." } ]`;
    private covered(l: Lecture) { return [...l.saved, ...l.drafts.map((x) => ({ q: plain(x.question), a: plain(x.answer) }))]; }
    private cardsPrompt(d: Doctor, l: Lecture, want: number, target: number) {
        const have = this.covered(l);
        const p = [this.BASE, this.ctx(d, l)];
        if (want > 0) p.push(`Create exactly ${want} NEW flashcards in this request (overall goal: ${target} cards from this material). Cover different facts from the cards already created. If the material has no more testable facts, return fewer or []. Never pad with trivial cards.`);
        else if (have.length) p.push("Continue: write cards for every testable fact NOT yet covered by the cards below. Return [] if everything is covered.");
        if (have.length) p.push("Already created (do NOT repeat or rephrase):\n" + have.map((c) => "- " + c.q.slice(0, 90)).join("\n"));
        return [...p, ...this.styleParts()].join("\n\n");
    }
    private addDrafts(l: Lecture, cards: any[], max: number) {
        const seen = new Set([...l.saved.map((s) => s.q), ...l.drafts.map((x) => plain(x.question)), ...l.rejected].map((x) => x.toLowerCase()));
        let n = 0;
        for (const c of cards ?? []) {
            if (n >= max) break;
            if (typeof c?.question !== "string" || typeof c?.answer !== "string") continue;
            const k = plain(c.question).toLowerCase();
            if (!k || seen.has(k)) continue;
            seen.add(k); n++;
            l.drafts.push({ question: this.colorize ? cleanCardHtml(c.question) : c.question, answer: this.colorize ? cleanCardHtml(c.answer) : c.answer, status: "pending", msg: "" });
        }
        return n;
    }
    private aiWrite(prompt: string, src: { base64: string; mime: string }, schema?: any) {
        return this.pool.run((key) => geminiJson({ apiKey: key, model: this.MODEL, prompt, file: src, schema, fast: true }), 120e3, { role: "write" });
    }

    private async extract(d: Doctor, l: Lecture, src: { base64: string; mime: string }) {
        const target = Math.floor(Number(this.cardCount)) || 0;
        const have = () => l.drafts.length + l.saved.length;
        if (target > 0) {
            let round = 0, empty = 0;
            while (have() < target && empty < 2 && round < Math.ceil(target / this.BATCH) + 4) {
                this.chk(); round++;
                l.progress = `${have()}/${target} cards`;
                const want = Math.min(this.BATCH, target - have());
                const { data } = await this.aiWrite(this.cardsPrompt(d, l, want, target), src);
                const n = this.addDrafts(l, Array.isArray(data) ? data : [], want);
                empty = n === 0 ? empty + 1 : 0; await this.flush(l);
            }
        } else {
            for (let round = 0; round < 8; round++) {
                this.chk();
                l.progress = `${have()} cards so far`;
                const { data, truncated } = await this.aiWrite(this.cardsPrompt(d, l, 0, 0), src);
                const n = this.addDrafts(l, Array.isArray(data) ? data : [], Infinity);
                await this.flush(l);
                if (!truncated || n === 0) break; // the AI finished (not cut off), or nothing new
            }
        }
    }

    private async audit(d: Doctor, l: Lecture, src: { base64: string; mime: string }) {
        for (let pass = 1; pass <= this.passes; pass++) {
            this.chk();
            l.status = "checking"; l.progress = `completeness pass ${pass}/${this.passes}`;
            const made = this.covered(l).map((c, i) => `${i + 1}. ${c.q.slice(0, 120)} => ${c.a.slice(0, 80)}`).join("\n");
            const rej = l.rejected.length ? `\nThe user REJECTED these on purpose, do not report their topics as missed:\n${l.rejected.map((q) => "- " + q.slice(0, 90)).join("\n")}` : "";
            const { data } = await this.aiWrite(`You are auditing flashcards made from the attached document/image. ${this.ctx(d, l)}

Flashcards already made (question => short answer):
${made}
${rej}

Read the attached document again from start to end. Find every important, testable fact, definition, list item, number, mechanism, classification or exception that NO card above covers, even partly. A fact counts as covered if a card tests it, even if worded differently. Ignore headers, filler and trivial details.
List at most 40 missed items, most important first. In "detail" quote the key facts from the document so cards can be written from it. "location" is the page or section. "coverage_percent" is your honest estimate (0-100). Write in the document's language. Return ONLY JSON.`, src, {
                type: "OBJECT",
                properties: { coverage_percent: { type: "NUMBER" }, missed: { type: "ARRAY", items: { type: "OBJECT", properties: { location: { type: "STRING" }, topic: { type: "STRING" }, detail: { type: "STRING" } }, required: ["location", "topic", "detail"] } } },
                required: ["coverage_percent", "missed"],
            });
            const missed: Missed[] = (Array.isArray(data?.missed) ? data.missed : []).filter((m: any) => m && typeof m.detail === "string");
            if (!missed.length || Number(data?.coverage_percent) >= 96) { this.say(`${l.name}: complete (pass ${pass})`); break; }
            l.status = "extracting";
            let added = 0;
            for (let i = 0; i < missed.length; i += 12) {
                this.chk();
                const chunk = missed.slice(i, i + 12);
                const prompt = [`You are helping build flashcards for a medical-education app from the attached document/image. ${this.ctx(d, l)}
An earlier pass already made cards, but the information below was MISSED. Find each item in the document (use the location hint) and write flashcards that cover it completely. Never invent anything. One item can need more than one card.
Return ONLY a JSON array: [ { "question": "...", "answer": "..." } ]`,
                    "Missed information:\n" + chunk.map((m) => `- [${m.location}] ${m.topic}: ${m.detail}`).join("\n"),
                    "Already created (do NOT repeat):\n" + this.covered(l).map((c) => "- " + c.q.slice(0, 90)).join("\n"), ...this.styleParts()].join("\n\n");
                const r = await this.aiWrite(prompt, src);
                added += this.addDrafts(l, Array.isArray(r.data) ? r.data : [], Infinity); await this.flush(l);
            }
            this.say(`${l.name}: pass ${pass} added ${added} cards`);
            if (!added) break;
        }
    }


    // ================= from Auto Polish =================
    private async analyzeDeck(d: { id: number; title: string }, src: { base64: string; mime: string } | null) {
        const { cards, skipped } = await this.loadCards(d.id, d.title);
        this.say(`${d.title}: ${cards.length} cards${skipped ? ` (${skipped} special cards skipped)` : ""}`);
        if (!cards.length) return;
        const byId = new Map(cards.map((c) => [c.id, c]));
        const gone = new Set<number>(); // cards already marked for deletion

        // 1) duplicates: local similarity first (free), then one AI pass over the whole deck
        if (this.optDups) {
            const t = cards.map((c) => ({ c, q: toks(c.q), a: toks(c.a) }));
            for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) {
                if (gone.has(t[i].c.id) || gone.has(t[j].c.id)) continue;
                const same = norm(t[i].c.q) === norm(t[j].c.q) ? jacc(t[i].a, t[j].a) >= 0.6 : jacc(t[i].q, t[j].q) >= 0.9 && jacc(t[i].a, t[j].a) >= 0.8;
                if (!same) continue;
                const [keep, del] = t[i].c.a.length >= t[j].c.a.length ? [t[i].c, t[j].c] : [t[j].c, t[i].c];
                gone.add(del.id);
                this.dups.push({ c: del, keeper: keep, reason: "Same question and answer", conf: 97, apply: false, st: "idle", msg: "" });
            }
            this.chk();
            const live = cards.filter((c) => !gone.has(c.id));
            for (let s = 0; s < live.length; s += 300) {
                const part = live.slice(s, s + 300);
                const { data } = await this.ai(`You are checking medical flashcards of the lecture "${d.title}" for DUPLICATES.
Two cards are duplicates only when they test exactly the same fact (even if worded differently or in another order). Cards that are merely related, or test different facts about the same topic, are NOT duplicates.
For each group choose the ONE card to keep (the clearest and most complete) and list the others to remove. Give a confidence 0-100 per group and a short reason in the cards' language.
Return ONLY JSON: {"groups":[{"keep":1,"remove":[2,3],"confidence":90,"reason":"..."}]}  (empty array if none)

Cards:
${JSON.stringify(part.map((c) => ({ id: c.id, q: plain(c.q).slice(0, 140), a: plain(c.a).slice(0, 80) })))}`,
                    { type: "OBJECT", properties: { groups: { type: "ARRAY", items: { type: "OBJECT", properties: { keep: { type: "INTEGER" }, remove: { type: "ARRAY", items: { type: "INTEGER" } }, confidence: { type: "NUMBER" }, reason: { type: "STRING" } }, required: ["keep", "remove", "confidence", "reason"] } } }, required: ["groups"] });
                for (const g of data?.groups ?? []) {
                    const keep = byId.get(g.keep); if (!keep || gone.has(keep.id)) continue;
                    for (const id of g.remove ?? []) {
                        const del = byId.get(id); if (!del || del.id === keep.id || gone.has(del.id)) continue;
                        gone.add(del.id);
                        this.dups.push({ c: del, keeper: keep, reason: String(g.reason ?? ""), conf: clamp(g.confidence), apply: false, st: "idle", msg: "" });
                    }
                }
            }
            this.say(`${d.title}: ${this.dups.filter((x) => x.c.deckId === d.id).length} duplicates found`);
        }

        // 2) quality review + "does it need a picture?" (one call per 20 cards)
        const needPics: { c: PCard; idea: string; terms: string[]; conf: number }[] = [];
        if (this.optQuality || this.optImages) {
            const live = cards.filter((c) => !gone.has(c.id));
            for (let s = 0; s < live.length; s += 20) {
                this.chk();
                this.progress = `${d.title}: reviewing cards ${s + 1}-${Math.min(s + 20, live.length)} of ${live.length}`;
                const part = live.slice(s, s + 20);
                const { data } = await this.ai(this.reviewPrompt(d.title, part, !!src), {
                    type: "ARRAY", items: { type: "OBJECT", properties: {
                        id: { type: "INTEGER" }, verdict: { type: "STRING" }, confidence: { type: "NUMBER" }, reason: { type: "STRING" },
                        new_q: { type: "STRING" }, new_a: { type: "STRING" },
                        needs_image: { type: "BOOLEAN" }, image_conf: { type: "NUMBER" }, image_idea: { type: "STRING" }, en_terms: { type: "ARRAY", items: { type: "STRING" } },
                    }, required: ["id", "verdict", "confidence", "reason", "needs_image", "image_conf", "image_idea", "en_terms"] },
                }, { file: src ?? undefined, maxTokens: 8192 });
                for (const o of Array.isArray(data) ? data : []) {
                    const c = byId.get(o?.id); if (!c || gone.has(c.id)) continue;
                    const conf = clamp(o.confidence);
                    if (this.optQuality && o.verdict === "remove") { gone.add(c.id); this.rems.push({ c, reason: String(o.reason ?? ""), conf, apply: false, st: "idle", msg: "" }); continue; }
                    if (this.optQuality && o.verdict === "fix" && typeof o.new_q === "string" && typeof o.new_a === "string" && o.new_q.trim() && o.new_a.trim()) {
                        const nq = cleanCardHtml(o.new_q), na = cleanCardHtml(o.new_a);
                        if (norm(nq) !== norm(c.q) || norm(na) !== norm(c.a)) this.fixes.push({ c: { ...c, q: c.q, a: c.a }, newQ: nq, newA: na, reason: String(o.reason ?? ""), conf, apply: false, st: "idle", msg: "" });
                    }
                    if (this.optImages && c.noPic && o.needs_image && clamp(o.image_conf) >= 30)
                        needPics.push({ c, idea: String(o.image_idea ?? ""), terms: (Array.isArray(o.en_terms) ? o.en_terms : []).map(String).filter(Boolean).slice(0, 4), conf: clamp(o.image_conf) });
                }
            }
            this.say(`${d.title}: review done, ${needPics.length} cards want a picture`);
        }

        // 3) pictures: search, then a vision model LOOKS at the candidates and picks (or rejects all)
        let n = 0;
        for (const p of needPics) {
            this.chk(); n++;
            this.progress = `${d.title}: pictures ${n}/${needPics.length}`;
            try { await this.findPicture(p); } catch (e: any) { if (e instanceof PoolStopped || e instanceof PoolExhausted) throw e; this.say(`Picture search failed for card ${p.c.id}: ${String(e?.message || e)}`); }
        }
    }

    private reviewPrompt(title: string, part: PCard[], hasSrc: boolean) {
        return this.reviewPromptBase(title, part, hasSrc) + (this.styleGuide
            ? `\n\nThis doctor writes his exam questions in a specific style (below). A card that already matches this style is GOOD: do not rewrite it away from the style. Fix a card that ignores the style only when you are also fixing a real problem.\n${this.styleGuide}` : "");
    }
    private reviewPromptBase(title: string, part: PCard[], hasSrc: boolean) {
        return `You are a strict senior medical educator reviewing flashcards for the lecture "${title}".${hasSrc ? " The lecture file is attached: check every card against it." : ""}
For EACH card decide:
- verdict "keep": the card is clear, correct, tests ONE useful fact. Do NOT rewrite cards only for style.
- verdict "fix": ambiguous or misleading question, an answer that is wrong or incomplete${hasSrc ? " compared with the file" : ""}, two facts in one card, typo. Provide "new_q" and "new_a": the corrected card in the SAME language and the SAME simple HTML style (<b>, <i>, <u>, <br>, <span style="color:#rrggbb">) as the original; keep any {{c1::...}} markers exactly; never change the meaning unless it was wrong.
- verdict "remove": too trivial, meaningless, garbled, or not worth testing.
Give "confidence" 0-100 (how sure you are of YOUR verdict) and a one-sentence "reason" in the card's language.
Then decide about a picture: "needs_image" is true whenever a picture would help a student see or memorise what the card is about: anatomy and structures, organs, histology, pathology and gross specimens, radiology (X-ray, CT, MRI, ultrasound), ECG/EEG traces, microbiology and organisms, parasites, clinical signs and rashes, procedures, instruments, drug / molecule structures, pathways and algorithms that have a well-known diagram, graphs. When in doubt and a picture of the subject is likely to exist, say true. It is false only for pure text facts with nothing to look at (definitions, numbers, doses, lists of names, legal or ethical rules). "image_conf" is 0-100. If true: "image_idea" = the thing to show in a few English words, "en_terms" = 3-4 English search phrases for Wikipedia / Wikimedia Commons, most specific first and then broader (proper English medical names). Otherwise leave them empty.
For "keep" cards, new_q and new_a must be empty strings.
Return ONLY a JSON array: [{"id":1,"verdict":"keep","confidence":90,"reason":"...","new_q":"","new_a":"","needs_image":false,"image_conf":0,"image_idea":"","en_terms":[]}]

Cards (HTML):
${JSON.stringify(part.map((c) => ({ id: c.id, q: c.q, a: c.a, has_picture: !c.noPic })))}`;
    }

    private async getJson(url: string) { const r = await fetch(url, { headers: { "User-Agent": UA } }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }
    private readonly IMGQ = "&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=600&iiextmetadatafilter=LicenseShortName";
    private async searchCands(terms: string[]): Promise<Cand[]> {
        let found: Cand[] = [];
        for (const t of terms) {
            try {
                const j = await this.getJson(`https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=0&gsrlimit=6&gsrsearch=${encodeURIComponent(t)}&prop=pageimages&piprop=thumbnail&pithumbsize=600`);
                for (const p of (Object.values(j?.query?.pages || {}) as any[]).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)))
                    if (p.thumbnail?.source) found.push({ thumb: p.thumbnail.source, title: p.title + " (en)", src: "https://en.wikipedia.org/wiki/" + encodeURIComponent(p.title), lic: "Wikipedia" });
            } catch {}
            try {
                const j = await this.getJson(`https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrlimit=10&gsrsearch=${encodeURIComponent(t)}${this.IMGQ}`);
                for (const p of (Object.values(j?.query?.pages || {}) as any[]).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
                    const ii = p.imageinfo?.[0];
                    if (ii && /^image\/(jpeg|png|webp|gif)/.test(ii.mime)) found.push({ thumb: ii.thumburl || ii.url, title: String(p.title || "").replace(/^File:/, ""), src: ii.descriptionurl || "", lic: ii.extmetadata?.LicenseShortName?.value || "" });
                }
            } catch {}
        }
        if (found.length < 8 && terms[0]) {
            try {
                const j = await this.getJson(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(terms[0])}&page_size=10&mature=false&license_type=all-cc`);
                for (const r of j.results || []) found.push({ thumb: r.thumbnail || r.url, title: r.title || "", src: r.foreign_landing_url || "", lic: String(r.license || "").toUpperCase() });
            } catch {}
        }
        const seen = new Set<string>();
        return found.filter((c) => c.thumb && !seen.has(c.thumb) && (seen.add(c.thumb), true));
    }
    /** Keeps searching until a picture clears the picture threshold (more candidate sets, then new search words); the best weaker one goes to "needs attention". */
    private async findPicture(p: { c: PCard; idea: string; terms: string[]; conf: number }) {
        const pth = this.cfg.pictureThreshold ?? this.cfg.threshold;
        const uniq = (a: string[]) => a.filter((t, i) => t && a.indexOf(t) === i);
        const st: { best: Img | null; why: string } = { best: null, why: "nothing found" };
        const tried = new Set<string>();
        const attempt = async (terms: string[], maxRounds: number): Promise<boolean> => {
            const cands = (await this.searchCands(terms)).filter((c) => !tried.has(c.thumb)).slice(0, 6 * maxRounds);
            for (let r = 0; r * 6 < cands.length; r++) {
                const part = cands.slice(r * 6, r * 6 + 6); part.forEach((c) => tried.add(c.thumb));
                const shots: { cand: Cand; img: { base64: string; mime: string } }[] = [];
                for (const c of part) { const img = await this.jpegB64(c.thumb); if (img) shots.push({ cand: c, img }); }
                if (!shots.length) continue;
                const { data } = await this.ai(`You are a medical-education picture editor. Look at the ${shots.length} attached pictures (picture 0, 1, 2... in the order attached) for this flashcard.
Card front: ${plain(p.c.q)}
Card back: ${plain(p.c.a)}
Thing to show: ${p.idea}
The picture will be placed on the ${p.c.side} of the card.
Candidate titles: ${shots.map((s, i) => `${i}: ${s.cand.title}`).join(" | ")}
Choose the ONE picture that best shows the thing (right organ / structure / drug / organism / diagram / sign) and would help a student memorise this card. A good, usable picture of the right subject is enough: it does not have to be perfect. Prefer clean diagrams and illustrations, but a clear photo, histology slide, scan or ECG of the right subject is fine too.
Reject ALL (pick = -1) ONLY if none shows the right subject, if they only share a word with it, contain watermarks or ads, are a collage, are unreadably small or blurry, or (when the picture goes on the FRONT) would print the answer as a text label.
"confidence" scale: 90-100 = unmistakably the right subject, clear and usable; 80-89 = right subject, small flaws; 60-79 = probably right but unsure; below 60 = doubtful. Judge the SUBJECT and usefulness, not artistic quality.
"reason" is one sentence in the card's language.
Return ONLY JSON: {"pick": 0, "confidence": 90, "reason": "..."}`,
                    { type: "OBJECT", properties: { pick: { type: "INTEGER" }, confidence: { type: "NUMBER" }, reason: { type: "STRING" } }, required: ["pick", "confidence", "reason"] },
                    { files: shots.map((x) => x.img), pics: true, maxTokens: 600 });
                const pick = Number(data?.pick);
                if (!Number.isInteger(pick) || pick < 0 || pick >= shots.length) { st.why = String(data?.reason ?? "no picture fits"); continue; }
                // second, independent look: a fresh call sees ONLY the chosen picture and must confirm it. Both must agree.
                const { data: v } = await this.ai(`You are a medical-education fact checker. One picture is attached. A colleague wants to put it on this flashcard.
Card front: ${plain(p.c.q)}
Card back: ${plain(p.c.a)}
Intended subject: ${p.idea}
Look at the picture on its own and answer honestly:
- "shows_subject": true only if the picture really shows the intended subject (right organ / structure / organism / sign / diagram), not just something with a similar name or a different species, organ, side or condition.
- "junk": true if it has a watermark, advert, collage, heavy text labels that would give the answer away, or is unreadably small or blurry.
- "confidence" scale: 90-100 = unmistakably the right subject and useful for this card; 80-89 = right subject, small flaws; 60-79 = probably right but unsure; below 60 = doubtful or wrong.
- "reason": one sentence in the card's language.
Return ONLY JSON: {"shows_subject": true, "junk": false, "confidence": 90, "reason": "..."}`,
                    { type: "OBJECT", properties: { shows_subject: { type: "BOOLEAN" }, junk: { type: "BOOLEAN" }, confidence: { type: "NUMBER" }, reason: { type: "STRING" } }, required: ["shows_subject", "junk", "confidence", "reason"] },
                    { files: [shots[pick].img], pics: true, maxTokens: 400 });
                if (!v?.shows_subject || v?.junk) { st.why = "second check rejected it: " + String(v?.reason ?? "wrong subject"); continue; }
                const cs = shots.map((x) => x.cand);
                // confidence = the LOWER of the two independent opinions
                const m: Img = { c: p.c, idea: p.idea, cands: cs, pick, reason: String(data?.reason ?? ""), conf: Math.min(clamp(data?.confidence), clamp(v?.confidence)), apply: false, bg: this.optBg, st: "idle", msg: "", preview: cs[pick].thumb };
                if (m.conf >= pth) { this.imgs.push(m); return true; }
                if (!st.best || m.conf > st.best.conf) st.best = m;
                st.why = `best match so far only ${m.conf}% sure`;
            }
            return false;
        };
        const t1 = uniq([...p.terms, p.idea]).slice(0, 4);
        if (!t1.length) return;
        if (await attempt(t1, 4)) return;
        // nothing good enough yet: ask for different search words and try again
        let alt: string[] = [];
        try {
            const { data } = await this.ai(`A medical flashcard needs a picture of: "${p.idea}".
Card front: ${plain(p.c.q)}
Card back: ${plain(p.c.a)}
These English search phrases found nothing good on Wikipedia / Wikimedia Commons: ${t1.join(" | ")}.
Give 4 DIFFERENT English search phrases: synonyms, the Latin / alternative name, a broader or narrower term, or the type of image (e.g. "histology", "diagram", "radiograph", "ECG").
Return ONLY JSON: {"terms": ["..."]}`,
                { type: "OBJECT", properties: { terms: { type: "ARRAY", items: { type: "STRING" } } }, required: ["terms"] }, { maxTokens: 300 });
            alt = uniq((Array.isArray(data?.terms) ? data.terms : []).map(String)).filter((t) => !t1.includes(t)).slice(0, 4);
        } catch (e: any) { if (e instanceof PoolStopped || e instanceof PoolExhausted) throw e; }
        if (alt.length && await attempt(alt, 3)) return;
        if (st.best) { this.imgs.push(st.best); return; } // below the threshold: reported for your attention, not applied
        this.noPicture.push(`${plain(p.c.q).slice(0, 80)}  (${p.idea}: ${st.why})`);
    }


    // ================= server glue =================
    styleGuide = "";
    /** Cards for this doctor's lectures are written (and reviewed) in the way HE asks exam questions. */
    setStyle(guide: string) {
        this.styleGuide = guide.trim();
        this.instructions = (this.cfg.instructions || "") + (this.styleGuide
            ? `\n\nHOW THIS DOCTOR ASKS EXAM QUESTIONS. Write the cards so they train exactly this: same question forms, same depth, and focus on what he tends to test:\n${this.styleGuide}` : "");
    }
    /** Reads the doctor's PREVIOUS questions (pasted text and/or a file) once and turns them into a short style guide. */
    async buildStyleGuide(doctor: string, text: string, src: { base64: string; mime: string } | null): Promise<string> {
        const prompt = `Below are PREVIOUS EXAM QUESTIONS written by Dr ${doctor} for the subject "${this.subject}"${src ? " (a file is attached)" : ""}${text.trim() ? ", plus pasted text" : ""}.
Study how this doctor thinks and write a STYLE GUIDE (max 350 words, same language as the questions) for someone who will turn his lectures into flashcards that prepare students for HIS exam:
- the question forms he uses (direct recall, MCQ-style, clinical case, compare/contrast, "which is NOT", lists, numbers, images...)
- how deep and how specific the questions are
- what kinds of facts he keeps testing (definitions, mechanisms, doses, classifications, exceptions, "first-line", values...) and what he never asks
- his wording habits and how short or long answers are
- 3 to 5 short example questions that show the style (copy at most 5, short)
Return JSON {"guide": "..."}.${text.trim() ? `\n\nPASTED QUESTIONS:\n${text.slice(0, 60000)}` : ""}`;
        const { data } = await this.pool.run((key) => geminiJson({ apiKey: key, model: this.MODEL, prompt, file: src ?? undefined, schema: { type: "OBJECT", properties: { guide: { type: "STRING" } }, required: ["guide"] }, fast: true }), 120e3, { role: "write" });
        return String((data as any)?.guide || "").slice(0, 3500);
    }
    // judge: best model first (Claude keys), `pics` = the step looks at pictures
    private ai(prompt: string, schema: any, o: { file?: any; files?: any[]; pics?: boolean; maxTokens?: number } = {}) {
        return this.pool.run((key) => geminiJson({
            apiKey: key, model: isClaudeKey(key) ? this.CLAUDE : this.JUDGE, prompt, schema, file: o.file, files: o.files, fast: true, maxTokens: o.maxTokens,
        }), 120e3, o.pics
            ? { only: canSeePictures, role: "pics", onlyMsg: "Pictures need a Gemini or Claude key. Add one." }
            : { prefer: isClaudeKey, role: "review" });
    }
    private async loadCards(deckId: number, deck: string): Promise<{ cards: PCard[]; skipped: number }> {
        const rows = await this.io.loadCards(deckId);
        const cards: PCard[] = []; let skipped = 0;
        for (const r of rows) {
            const q = r.data?.front?.text, a = r.data?.back?.text;
            if (["BASIC", "CLOZE"].includes(String(r.type).toUpperCase()) && typeof q === "string" && typeof a === "string")
                cards.push({ id: r.id, deckId, deck, type: r.type, data: r.data, q, a, side: "back", noPic: !r.hasPic });
            else skipped++;
        }
        return { cards, skipped };
    }
    private async jpegB64(url: string): Promise<{ base64: string; mime: string } | null> {
        try {
            const r = await fetch(url, { headers: { "User-Agent": UA } }); if (!r.ok) return null;
            const buf = await sharp(Buffer.from(await r.arrayBuffer())).resize(512, 512, { fit: "inside", withoutEnlargement: true })
                .flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer();
            return { base64: buf.toString("base64"), mime: "image/jpeg" };
        } catch { return null; }
    }
    /** Server replacement for the browser cutout model: only removes a plain WHITE background (flood fill from the edges). */
    private async whiteToAlpha(png: Buffer): Promise<Buffer> {
        const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const w = info.width, h = info.height;
        const white = (p: number) => data[p * 4] >= 238 && data[p * 4 + 1] >= 238 && data[p * 4 + 2] >= 238 && data[p * 4 + 3] > 200;
        let edge = 0, edgeWhite = 0;
        const border: number[] = [];
        for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
        for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1);
        for (const p of border) { edge++; if (white(p)) edgeWhite++; }
        if (edgeWhite / edge < 0.9) return png; // not a plain white background: keep the picture as it is
        const seen = new Uint8Array(w * h); const stack: number[] = [];
        for (const p of border) if (white(p) && !seen[p]) { seen[p] = 1; stack.push(p); }
        while (stack.length) {
            const p = stack.pop()!; data[p * 4 + 3] = 0;
            const x = p % w, y = (p - x) / w;
            for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1])
                if (q >= 0 && !seen[q] && white(q)) { seen[q] = 1; stack.push(q); }
        }
        return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    }
    private async doImage(m: Img) {
        const res = await fetch(m.cands[m.pick].thumb, { headers: { "User-Agent": UA } });
        if (!res.ok) throw new Error("download " + res.status);
        let png = await sharp(Buffer.from(await res.arrayBuffer())).resize(800, 800, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
        if (m.bg) png = await this.whiteToAlpha(png);
        await this.io.attach(m.c.id, png);
    }

    /** Writes the cards waiting in l.drafts to the database right away (so a crash never loses them). */
    async flush(l: Lecture) {
        for (const c of [...l.drafts]) {
            await this.io.saveCard(l.deckId!, c.question, c.answer);
            l.saved.push({ q: plain(c.question), a: plain(c.answer) });
            l.drafts = l.drafts.filter((x) => x !== c);
        }
        this.persist();
    }

    /** create cards -> completeness passes -> review/fix/duplicates -> pictures. Resumable: l.stage says where it stopped. */
    async processLecture(d: Doctor, l: Lecture, src: { base64: string; mime: string }) {
        if (l.stage === "queued") {
            l.status = "creating cards"; l.msg = "";
            await this.extract(d, l, src); await this.flush(l);
            if (this.passes > 0 && l.saved.length > 0) await this.audit(d, l, src);
            await this.flush(l);
            l.extracted = true; l.stage = "written"; l.progress = "";
            this.say(`${l.name}: ${l.saved.length} cards created`); this.persist();
        }
        if (l.stage === "written") {
            l.status = "polishing";
            await this.polish(l, this.cfg.polishWithFile ? src : null);
            l.stage = "done"; l.status = "done"; this.persist();
        }
    }

    private async polish(l: Lecture, src: { base64: string; mime: string } | null) {
        this.fixes = []; this.dups = []; this.rems = []; this.imgs = []; this.noPicture = [];
        l.rep = { fixes: [], deleted: [], pictures: [], noPicture: [], lowConf: [] };
        await this.analyzeDeck({ id: l.deckId!, title: l.name }, src);
        const th = this.cfg.threshold, dth = this.cfg.deleteThreshold, pth = this.cfg.pictureThreshold ?? th, rep = l.rep;
        const brief = (c: PCard) => ({ id: c.id, q: plain(c.q), a: plain(c.a) });
        // deletions (stricter threshold). A card that is the "keeper" of another deletion is never deleted.
        const delIds = new Set<number>([...this.dups.filter((x) => x.conf >= dth).map((x) => x.c.id), ...this.rems.filter((x) => x.conf >= dth).map((x) => x.c.id)]);
        const dupDo = this.dups.filter((x) => x.conf >= dth && !delIds.has(x.keeper.id));
        const remDo = this.rems.filter((x) => x.conf >= dth);
        this.progress = "applying";
        for (const f of this.fixes) {
            if (delIds.has(f.c.id)) continue;
            if (f.conf < th) { rep.lowConf.push({ kind: "fix", ...brief(f.c), newQ: plain(f.newQ), newA: plain(f.newA), reason: f.reason, conf: f.conf }); continue; }
            try {
                const data = JSON.parse(JSON.stringify(f.c.data)); data.front.text = f.newQ; data.back.text = f.newA;
                await this.io.updateCard(f.c.deckId, f.c.id, f.c.type, data);
                rep.fixes.push({ ...brief(f.c), newQ: plain(f.newQ), newA: plain(f.newA), reason: f.reason, conf: f.conf });
            } catch (e: any) { rep.lowConf.push({ kind: "fix failed", ...brief(f.c), reason: String(e?.message || e), conf: f.conf }); }
        }
        for (const x of [...dupDo.map((d) => ({ kind: "duplicate", c: d.c, reason: d.reason, conf: d.conf, keep: brief(d.keeper) })), ...remDo.map((r) => ({ kind: "removed", c: r.c, reason: r.reason, conf: r.conf, keep: null as any }))]) {
            try { await this.io.deleteCard(x.c.deckId, x.c.id); rep.deleted.push({ kind: x.kind, ...brief(x.c), reason: x.reason, conf: x.conf, keptInstead: x.keep }); }
            catch (e: any) { rep.lowConf.push({ kind: "delete failed", ...brief(x.c), reason: String(e?.message || e), conf: x.conf }); }
        }
        for (const x of [...this.dups.filter((d) => d.conf < dth), ...this.rems.filter((r) => r.conf < dth)])
            rep.lowConf.push({ kind: "keeper" in x ? "possible duplicate" : "possible removal", ...brief(x.c), reason: x.reason, conf: x.conf });
        for (const m of this.imgs) {
            if (delIds.has(m.c.id)) continue;
            if (m.conf < pth) { rep.lowConf.push({ kind: "picture", ...brief(m.c), reason: `${m.idea}: ${m.reason}`, conf: m.conf, preview: m.preview }); continue; }
            try {
                await this.doImage(m);
                const cd = m.cands[m.pick];
                rep.pictures.push({ ...brief(m.c), idea: m.idea, title: cd.title, src: cd.src, lic: cd.lic, conf: m.conf, thumb: cd.thumb });
            } catch (e: any) { rep.lowConf.push({ kind: "picture failed", ...brief(m.c), reason: String(e?.message || e), conf: m.conf }); }
        }
        rep.noPicture = this.noPicture.slice(0, 200);
        this.say(`${l.name}: ${rep.fixes.length} fixed, ${rep.deleted.length} deleted, ${rep.pictures.length} pictures, ${rep.lowConf.length} for your attention`);
    }
}

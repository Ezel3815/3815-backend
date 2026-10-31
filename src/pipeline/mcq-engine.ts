/* eslint-disable */
// Server-side MCQ import engine. The uploaded files ALREADY contain the questions: the AI only
// (1) reads each question + its options exactly as written and (2) finds / chooses the correct answer.
// Runs inside the pipeline worker, so it works with the browser closed (same as the cards pipeline).
import { createHash } from "crypto";
import { geminiJson } from "./gemini-json";
import { KeyPool, PoolStopped } from "./key-pool";
import { Lecture } from "./engine";

export interface McqCfg {
    kind: "mcq";
    subject: string; // display name of the subject
    autoPublish: boolean; // publish questions whose answer is trusted
    publishThreshold: number; // AI-chosen answers below this confidence wait for the admin
    instructions: string;
}

export interface McqIO {
    log(m: string): void;
    persist(): void;
    importBank(body: any): Promise<{ applied: boolean; issues: { kind: string; id: string | null; message: string }[]; created: any; updated: any }>;
}

export interface McqSrc { base64: string; mime: string }

const plain = (s: string) => (s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const norm = (s: string) => plain(s).toLowerCase().replace(/[ً-ٰٟ]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const clamp = (n: any) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
const sha = (s: string, n: number) => createHash("sha1").update(s).digest("hex").slice(0, n);

/** Lowercase, id-safe slug. Names with no latin letters (Arabic ...) fall back to a hash. */
export function slugId(name: string, prefix: string): string {
    const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28);
    return s ? `${s}-${sha(name, 6)}` : `${prefix}-${sha(name, 10)}`;
}

/** "A", "a)", "(B)", "1", "أ" -> comparable key */
const labelKey = (s: any) => String(s ?? "").trim().replace(/^[\s(\[]+|[\s)\].:\-]+$/g, "").toUpperCase();

export class McqEngine {
    readonly MODEL = "gemini-3.5-flash";
    constructor(public pool: KeyPool, public cfg: McqCfg, public io: McqIO) {}
    private chk() { if (this.pool.stopped) throw new PoolStopped("Paused"); }

    private prompt(l: Lecture, have: { text: string }[]) {
        const p = [
            `You are importing multiple-choice questions (MCQs) for a medical-education app from the attached file (file name: "${l.fileName}", topic: "${l.name}").
The file ALREADY contains the questions and their options. Do NOT write new questions and do NOT rephrase anything: copy every question and every option exactly as written (same language, same wording, same numbers).
For every question find the correct answer:
1. If the file shows it (an answer key / table, a ticked, bold, underlined or highlighted option, "Answer: C", an explanation that names it), use exactly that and set "marked": true.
2. If the file does not show it, choose the correct option yourself from your medical knowledge and set "marked": false.
"confidence" is 0-100: how sure you are that the chosen answer is right (95-100 when it is read from the file).
If a question truly has several correct answers, list all of them in "correct".
"explanation": copy it only if the file contains one, otherwise "".
Skip anything that is not a question with options, and skip a question that is cut off so that it cannot be read completely.
Return ONLY a JSON array, no markdown fences, no commentary, in exactly this shape:
[ { "number": 1, "question": "...", "options": [ { "label": "A", "text": "..." }, { "label": "B", "text": "..." } ], "correct": ["B"], "marked": true, "confidence": 98, "explanation": "" } ]`,
        ];
        if (this.cfg.instructions.trim()) p.push(`Extra instructions from the admin (follow them, but still return ONLY the JSON in the shape above):\n${this.cfg.instructions.trim()}`);
        if (have.length) p.push(`Already extracted (do NOT repeat these):\n${have.slice(-60).map((h) => "- " + plain(h.text).slice(0, 70)).join("\n")}\n\nContinue with the NEXT questions in the file that are not in this list. Return [] if there are none left.`);
        return p.join("\n\n");
    }

    private ask(l: Lecture, src: McqSrc, have: { text: string }[], textFile: string | null) {
        let prompt = this.prompt(l, have);
        if (textFile !== null) prompt += `\n\nFile content:\n${textFile}`;
        return this.pool.run(
            (key) => geminiJson({ apiKey: key, model: this.MODEL, prompt, file: textFile === null ? src : undefined, maxTokens: 16000, fast: true }),
            120e3, { role: "write" },
        );
    }

    /** Raw AI item -> import record (or a reason why it was rejected). */
    private toRecord(it: any, colId: string, subjectId: string, source: string) {
        const text = typeof it?.question === "string" ? it.question.trim() : "";
        if (!text) return { error: "empty question" };
        const rawOpts: any[] = Array.isArray(it.options) ? it.options : [];
        const opts = rawOpts.map((o) => ({ label: labelKey(o?.label), text: String(o?.text ?? "").trim() })).filter((o) => o.text);
        if (opts.length < 2) return { error: `"${plain(text).slice(0, 50)}": fewer than 2 options` };
        if (opts.length > 12) return { error: `"${plain(text).slice(0, 50)}": more than 12 options` };
        const ids = opts.map((_, i) => String.fromCharCode(97 + i)); // a, b, c ...
        const picked = new Set<string>();
        for (const c of Array.isArray(it.correct) ? it.correct : [it.correct]) {
            const k = labelKey(c);
            if (!k) continue;
            let idx = opts.findIndex((o) => o.label === k);
            if (idx < 0 && /^\d+$/.test(k) && Number(k) >= 1 && Number(k) <= opts.length) idx = Number(k) - 1;
            if (idx < 0) idx = opts.findIndex((o) => norm(o.text) === norm(String(c)));
            if (idx >= 0) picked.add(ids[idx]);
        }
        if (!picked.size) return { error: `"${plain(text).slice(0, 50)}": the AI gave no usable correct answer` };
        const marked = it.marked === true;
        const conf = marked ? Math.max(clamp(it.confidence), 90) : clamp(it.confidence);
        const review = !marked && conf < this.cfg.publishThreshold;
        const id = `${colId}-${sha(norm(text), 10)}`; // same question text -> same id: re-running the job never duplicates
        return {
            q: {
                id, collection_id: colId, subject_id: subjectId, text,
                options: opts.map((o, i) => ({ id: ids[i], text: o.text })),
                correct: ids.filter((x) => picked.has(x)),
                explanation: typeof it.explanation === "string" && it.explanation.trim() ? it.explanation.trim() : null,
                source: source.slice(0, 255),
                published: this.cfg.autoPublish && !review,
            },
            marked, conf, review,
        };
    }

    async processFile(l: Lecture & { colId?: string }, src: McqSrc, subjectId: string, colId: string) {
        l.colId = colId;
        const textFile = src.mime === "text/plain" ? Buffer.from(src.base64, "base64").toString("utf8").slice(0, 400_000) : null;
        l.status = "reading questions"; l.msg = "";
        const colRec = (published: boolean) => ({ id: colId, subject_id: subjectId, title: l.name, published });
        const first = await this.io.importBank({ collections: [colRec(false)] });
        if (!first.applied) throw new Error(first.issues.map((i) => i.message).join("; ") || "Could not create the collection.");

        const seen = new Set<string>(l.saved.map((s) => s.q)); // ids already saved (resume after a stop)
        const have: { text: string }[] = l.saved.map((s) => ({ text: s.a })); // after a stop/resume the AI continues after these
        let anyPublished = false, round = 0, emptyRounds = 0;
        const rep = l.rep;
        while (round < 12 && emptyRounds < 1) {
            this.chk(); round++;
            const { data } = await this.ask(l, src, have, textFile);
            const items: any[] = Array.isArray(data) ? data : Array.isArray(data?.questions) ? data.questions : [];
            const batch: any[] = [];
            const meta = new Map<string, { marked: boolean; conf: number; review: boolean; correct: string[]; text: string }>();
            let fresh = 0;
            for (const it of items) {
                const r: any = this.toRecord(it, colId, subjectId, l.fileName);
                if (r.error) { l.rejected.push(r.error); continue; }
                const k = r.q.id as string;
                if (seen.has(k) || meta.has(k)) continue; // duplicate of one already read
                have.push({ text: r.q.text }); fresh++;
                meta.set(k, { marked: r.marked, conf: r.conf, review: r.review, correct: r.q.correct, text: r.q.text });
                batch.push(r.q);
            }
            if (!fresh) { emptyRounds++; continue; }
            for (let i = 0; i < batch.length; i += 200) {
                const part = batch.slice(i, i + 200);
                const res = await this.io.importBank({ questions: part });
                const bad = new Map(res.issues.filter((x) => x.kind === "question").map((x) => [x.id, x.message]));
                for (const q of part) {
                    if (bad.has(q.id)) { l.rejected.push(`"${plain(q.text).slice(0, 50)}": ${bad.get(q.id)}`); continue; }
                    seen.add(q.id); l.saved.push({ q: q.id, a: plain(q.text).slice(0, 70) });
                    const m = meta.get(q.id)!;
                    if (q.published) anyPublished = true;
                    const L: any = l;
                    if (m.review) rep.lowConf.push({ kind: "check answer", id: q.id, q: plain(q.text).slice(0, 160), a: m.correct.join(",").toUpperCase(), conf: m.conf, reason: "The file does not show the answer; the AI chose it." });
                    if (!m.marked) L.aiPicked = (L.aiPicked ?? 0) + 1; // answer chosen by the AI (confident ones are published, low ones are listed above)
                }
            }
            l.progress = `${l.saved.length} questions`; this.io.persist();
        }
        // the collection becomes visible in the app only when it has at least one published question
        await this.io.importBank({ collections: [colRec(anyPublished)] });
        this.io.log(`${l.name}: ${l.saved.length} questions saved, ${rep.lowConf.length} need your check${l.rejected.length ? `, ${l.rejected.length} could not be read` : ""}`);
        l.progress = ""; l.stage = "done"; l.status = "done"; l.extracted = true; this.io.persist();
    }
}

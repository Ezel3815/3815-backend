/* eslint-disable */
// Time estimate for pipeline jobs ("create cards" jobs and "polish existing decks" jobs).
// Pure functions only (no database, no AI): the service feeds in card counts / file sizes / the number of working keys.
//
// The numbers in T are first guesses of how long one AI call or one picture takes. They are NOT measured by this code:
// every finished lecture stores how long it really took (see PipelineService.noteTiming), and `calibration()` turns those
// into a correction factor, so the estimate gets closer to reality the more jobs have run on this server.

export interface EstCfg {
    cardCount?: number | null; passes?: number; polishWithFile?: boolean;
    optQuality?: boolean; optDups?: boolean; optImages?: boolean;
    pictureMode?: "smart" | "generous" | "all";
    models3dMode?: "anatomy" | "all" | "off";
    parallel?: number;
}
export interface EstLecture {
    name: string;
    kind: "create" | "polish";
    /** polish: cards in the deck. create: leave empty, it is guessed from sizeMB (or cfg.cardCount). */
    cards?: number;
    /** polish: cards that have no picture yet */
    noPic?: number;
    /** create: size of the lecture file */
    sizeMB?: number;
    /** polish: a lecture file was uploaded for the reviewer */
    hasFile?: boolean;
}
export interface EstPart { key: string; label: string; seconds: number }
export interface EstLectureOut { name: string; cards: number; seconds: number }
export interface Estimate {
    seconds: number; lowSeconds: number; highSeconds: number;
    lectures: number; cards: number; lanes: number; keys: number;
    parts: EstPart[]; perLecture: EstLectureOut[];
    calibrated: boolean; samples: number; factor: number;
    warning: string | null;
}

/** Seconds. Single lecture, one lane, before calibration. */
export const T = {
    write: 40,          // one "write 25 cards" call with the lecture file attached
    writeAuto: 60,      // auto card count: bigger answers
    auditPass: [115, 70], // completeness pass 1 / 2: one audit call + about 2 write calls (pass 2 often stops early)
    review: 30,         // review 20 cards (quality + "needs a picture")
    reviewFile: 50,     // same, lecture file attached (30 cards per call, 2 at a time)
    dups: 25,           // one duplicate check over up to 300 cards
    modelProbe: 5,      // "is this an anatomy deck?"
    modelBatch: 30,     // match 30 cards to the 3D library
    pickBatch: 12,      // choose pictures for 30 cards (fast model)
    picture: 28,        // find + look at candidates + double check ONE picture
    applyCard: 0.2,     // database work per card
    applyPicture: 1.5,  // resize + save one picture
    fileLoad: 3,        // reading the lecture file back from the database
    style: 35,          // learning one doctor's exam style
    anatomyShare: 0.3,  // "anatomy only" mode: share of decks assumed to be anatomy
    cardsPerMB: 15, minAuto: 25, maxAuto: 120,
    pictureShare: { smart: 0.2, generous: 0.4, all: 0.8 } as Record<string, number>,
    spread: { low: 0.7, high: 1.9, lowCal: 0.8, highCal: 1.5 }, // rate limits and key cooling make real runs slower, rarely faster
};

const ceil = (a: number, b: number) => Math.max(0, Math.ceil(a / b));

export function autoCards(sizeMB: number | undefined, cfg: EstCfg): number {
    const want = Math.floor(Number(cfg.cardCount)) || 0;
    if (want > 0) return want;
    return Math.max(T.minAuto, Math.min(T.maxAuto, Math.round((sizeMB || 1) * T.cardsPerMB)));
}

/** How long ONE lecture takes on one lane (before calibration), split into parts for the breakdown. */
export function lectureParts(l: EstLecture, cfg: EstCfg, keys: number): { cards: number; parts: EstPart[] } {
    const parts: EstPart[] = []; const add = (key: string, label: string, seconds: number) => { if (seconds > 0.5) parts.push({ key, label, seconds }); };
    const k = Math.max(1, keys);
    const created = l.kind === "create";
    const cards = created ? autoCards(l.sizeMB, cfg) : Math.max(0, Math.floor(l.cards ?? 0));
    const noPic = created ? cards : Math.max(0, Math.min(cards, Math.floor(l.noPic ?? cards)));
    const withFile = created ? cfg.polishWithFile !== false : !!l.hasFile;
    if (created) {
        add("load", "Reading the file", T.fileLoad);
        const fixed = Math.floor(Number(cfg.cardCount)) > 0;
        add("write", "Writing the cards", fixed ? ceil(cards, 25) * T.write : Math.max(1, ceil(cards, 60)) * T.writeAuto);
        const passes = Math.max(0, Math.min(2, Number(cfg.passes ?? 1)));
        add("audit", "Completeness passes", T.auditPass.slice(0, passes).reduce((a, b) => a + b, 0));
    } else if (l.hasFile) add("load", "Reading the file", T.fileLoad);
    if (!cards) return { cards, parts };

    const optQuality = cfg.optQuality !== false, optDups = cfg.optDups !== false, optImages = cfg.optImages !== false;
    const conc = Math.max(1, Math.min(withFile ? 2 : 4, k)), concAny = Math.max(1, Math.min(4, k));
    if (optDups) add("dups", "Duplicates", ceil(cards, 300) * T.dups);
    if (optQuality || optImages) {
        const B = withFile ? 30 : 20;
        add("review", "Reviewing the cards", ceil(ceil(cards, B), conc) * (withFile ? T.reviewFile : T.review));
    }
    const mode = cfg.models3dMode ?? "anatomy";
    if (mode !== "off") {
        const share = mode === "all" ? 1 : T.anatomyShare;
        add("models", "3D models", T.modelProbe + share * ceil(ceil(cards, 30), concAny) * T.modelBatch);
    }
    const pm = cfg.pictureMode ?? (created ? "smart" : "generous");
    if (optImages) {
        if (pm !== "smart") add("pick", "Choosing pictures", ceil(ceil(noPic, 30), concAny) * T.pickBatch);
        const pics = Math.round(noPic * (T.pictureShare[pm] ?? T.pictureShare.smart));
        add("pictures", "Finding pictures", ceil(pics, concAny) * T.picture);
        add("apply", "Saving changes", cards * T.applyCard + pics * T.applyPicture);
    } else add("apply", "Saving changes", cards * T.applyCard);
    return { cards, parts };
}

export interface EstInput { kind: "create" | "polish"; cfg: EstCfg; lectures: EstLecture[]; keys: number; styleDoctors?: number; calibration?: { factor: number; samples: number } | null }

export function estimate(inp: EstInput): Estimate {
    const { cfg, keys } = inp;
    const lecs = inp.lectures.map((l) => ({ l, ...lectureParts(l, cfg, keys) }));
    const secs = lecs.map((x) => x.parts.reduce((a, p) => a + p.seconds, 0));
    const lanes = Math.max(1, Math.min(Math.floor(Number(cfg.parallel)) || 2, 3, Math.max(1, keys), Math.max(1, lecs.length)));
    const styleSecs = (inp.styleDoctors ?? 0) * T.style;
    // lectures are handed out one by one to the lanes: the job takes at least as long as its longest lecture
    const base = styleSecs + Math.max(secs.reduce((a, b) => a + b, 0) / lanes, ...secs, 0);
    const cal = inp.calibration && inp.calibration.samples >= 3 ? inp.calibration : null;
    const f = cal ? cal.factor : 1;
    const sp = cal ? { lo: T.spread.lowCal, hi: T.spread.highCal } : { lo: T.spread.low, hi: T.spread.high };
    const partMap = new Map<string, EstPart>();
    for (const x of lecs) for (const p of x.parts) { const q = partMap.get(p.key) ?? { key: p.key, label: p.label, seconds: 0 }; q.seconds += p.seconds; partMap.set(p.key, q); }
    if (styleSecs) partMap.set("style", { key: "style", label: "Learning exam style", seconds: styleSecs });
    const round = (n: number) => Math.round(n);
    return {
        seconds: round(base * f), lowSeconds: round(base * f * sp.lo), highSeconds: round(base * f * sp.hi),
        lectures: lecs.length, cards: lecs.reduce((a, x) => a + x.cards, 0), lanes, keys,
        parts: [...partMap.values()].map((p) => ({ ...p, seconds: round(p.seconds * f / lanes) })),
        perLecture: lecs.map((x, i) => ({ name: x.l.name, cards: x.cards, seconds: round(secs[i] * f) })),
        calibrated: !!cal, samples: inp.calibration?.samples ?? 0, factor: Math.round(f * 100) / 100,
        warning: keys < 1 ? "The server has no working AI key, so the job cannot run yet. Add keys in Pipeline > AI keys." : null,
    };
}

/** Median of (real seconds / predicted seconds) over finished lectures. Needs at least 3 samples to be used. */
export function calibration(samples: { ms: number; pred: number }[]): { factor: number; samples: number } | null {
    const r = samples.filter((s) => s.ms > 0 && s.pred > 0).map((s) => s.ms / 1000 / s.pred).sort((a, b) => a - b);
    if (r.length < 3) return null;
    const m = r.length % 2 ? r[(r.length - 1) / 2] : (r[r.length / 2 - 1] + r[r.length / 2]) / 2;
    return { factor: Math.max(0.4, Math.min(4, m)), samples: r.length };
}

// Local (free, no AI) duplicate detection for one deck of cards.
//
// This used to live inside Engine.analyzeDeck and called norm() twice for EVERY pair of cards.
// norm() is a chain of regex passes, so a deck of 1,500 cards meant about 1.1 million pairs and
// 2+ million regex chains in one synchronous loop: the event loop froze for many seconds (the host's
// health check then restarts the server, which looks exactly like a crash) and the garbage it made
// pushed memory up. Now every card is normalised ONCE, pairs that cannot be similar are skipped
// with a cheap length check, and the loop gives the event loop a breath every few cards.
// The result is exactly the same as before (same pairs, same order, same keeper choice).

export const plain = (h: string) => (h ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;|&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
export const norm = (h: string) => plain(h).toLowerCase().replace(/[ً-ٰٟ]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
export const toks = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 1));
export const jacc = (a: Set<string>, b: Set<string>) => { if (!a.size && !b.size) return 1; let i = 0; a.forEach((x) => b.has(x) && i++); return i / (a.size + b.size - i); };

export interface DupCardLike { id: number; q: string; a: string }

/** jaccard(A, B) <= min(|A|, |B|) / max(|A|, |B|), so two sets whose sizes differ this much can never reach `min`. */
const sizesCanMatch = (x: number, y: number, min: number) => x === y || Math.min(x, y) / Math.max(x, y) >= min;

/** Returns every card that is a (near) copy of another one, together with the card to keep. */
export async function findLocalDuplicates<T extends DupCardLike>(cards: T[], beforeBatch: () => void = () => {}): Promise<{ keep: T; del: T }[]> {
    const t = cards.map((c) => { const nq = norm(c.q); return { c, nq, q: new Set(nq.split(" ").filter((w) => w.length > 1)), a: toks(c.a) }; });
    const gone = new Set<number>();
    const out: { keep: T; del: T }[] = [];
    for (let i = 0; i < t.length; i++) {
        if (i % 40 === 0) { await new Promise<void>((r) => setImmediate(r)); beforeBatch(); }
        const ti = t[i];
        for (let j = i + 1; j < t.length; j++) {
            if (gone.has(ti.c.id)) break;
            const tj = t[j];
            if (gone.has(tj.c.id)) continue;
            const same = ti.nq === tj.nq
                ? jacc(ti.a, tj.a) >= 0.6
                : sizesCanMatch(ti.q.size, tj.q.size, 0.9) && jacc(ti.q, tj.q) >= 0.9 && jacc(ti.a, tj.a) >= 0.8;
            if (!same) continue;
            const [keep, del] = ti.c.a.length >= tj.c.a.length ? [ti.c, tj.c] : [tj.c, ti.c];
            gone.add(del.id);
            out.push({ keep, del });
        }
    }
    return out;
}

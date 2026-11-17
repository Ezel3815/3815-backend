// Small helpers that keep the pipeline inside a small server's memory (e.g. a 512 MB free instance).
// Pure TypeScript, no dependencies.

/** At most `n` jobs run at once; the rest wait in line. */
export class Semaphore {
    private free: number;
    private waiters: (() => void)[] = [];
    constructor(n: number) { this.free = Math.max(1, n); }
    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.free > 0) this.free--;
        else await new Promise<void>((go) => this.waiters.push(go)); // the slot is handed over directly by the one that finishes
        try { return await fn(); }
        finally { const next = this.waiters.shift(); if (next) next(); else this.free++; }
    }
}

/**
 * A memory budget for AI requests that carry a file.
 *
 * Sending a lecture PDF to the AI costs far more than the file itself: the base64 text (+33%) is copied again by
 * JSON.stringify and once more when the request body is encoded, and a lecture can have several requests running at
 * the same time (lectures side by side x several review batches each). Without a limit, 3 lectures x 4 batches x an
 * 18 MB PDF is well over a gigabyte. Here a request must first get its share of the budget; the rest wait in line.
 *
 * - A request bigger than the whole budget still runs, alone (the gate never deadlocks).
 * - An idle gate always lets one request in, even if the process is above `softRss`.
 * - While the process is above `softRss` bytes of memory, new requests wait until a running one finishes.
 */
export class ByteGate {
    private used = 0;
    private waiters: { w: number; go: () => void }[] = [];
    constructor(private budget: number, private softRss = Infinity, private minTracked = 1 << 20) {}

    private fits(w: number) {
        if (this.used === 0) return true;
        if (this.used + w > this.budget) return false;
        return process.memoryUsage.rss() < this.softRss;
    }
    private drain() {
        while (this.waiters.length && this.fits(this.waiters[0].w)) {
            const x = this.waiters.shift()!;
            this.used += x.w;
            x.go();
        }
    }
    /** Resolves with a release() function once `weight` bytes fit in the budget. Always call release() (use finally). */
    async acquire(weight: number): Promise<() => void> {
        if (!(weight >= this.minTracked)) return () => {}; // small requests (pictures, text) are not worth tracking
        const w = Math.min(weight, this.budget);
        if (this.waiters.length === 0 && this.fits(w)) this.used += w;
        else await new Promise<void>((go) => this.waiters.push({ w, go }));
        let done = false;
        return () => { if (done) return; done = true; this.used -= w; this.drain(); };
    }
    get inFlight() { return this.used; }
    get queued() { return this.waiters.length; }
}

/** "rss=312MB heap=148MB external=63MB" for the server log. */
export function memLine(): string {
    const m = process.memoryUsage();
    const mb = (n: number) => Math.round(n / 1048576) + "MB";
    return `rss=${mb(m.rss)} heap=${mb(m.heapUsed)} external=${mb(m.external)}`;
}

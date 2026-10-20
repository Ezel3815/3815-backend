// A pool of API keys. Every AI call goes through run(): if a key hits its limit,
// is invalid or the service is busy, the next key is tried automatically.
// Key formats: Gemini key as-is, "mistral:KEY", or a Claude key starting with "sk-ant-".
// Each key can be reserved for a job: "write" (creating cards), "review" (judging cards)
// or "pics" (looking at pictures). "any" keys help with every job.

export type Role = "any" | "write" | "review" | "pics";
export const ROLE_LABEL: Record<Role, string> = { any: "Any job", write: "Creating cards", review: "Reviewing cards", pics: "Pictures" };

export interface PoolKey {
    key: string;
    role: Role;
    until: number; // cooling down until this time (ms); 0 = ready
    dead: boolean; // invalid key: never used again
    reason: string;
    ok: number; // successful calls
    last: number; // last time used (for fair rotation)
}

export const isClaudeKey = (k: string) => k.trim().startsWith("sk-ant-");
export const isMistralKey = (k: string) => /^mistral:/i.test(k.trim());
export const canSeePictures = (k: string) => !isMistralKey(k);

export interface RunOpts {
    role?: Role; // which job this call belongs to
    prefer?: (key: string) => boolean; // use these keys first (falls back to the others)
    only?: (key: string) => boolean; // use ONLY these keys
    onlyMsg?: string;
}

export class PoolExhausted extends Error {}
export class PoolStopped extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function keyLabel(k: string): string {
    const t = k.trim();
    const kind = /^mistral:/i.test(t) ? "Mistral" : t.startsWith("sk-ant-") ? "Claude" : "Gemini";
    const raw = t.replace(/^mistral:/i, "");
    return `${kind} …${raw.slice(-5)}`;
}

export class KeyPool {

    keys: PoolKey[] = [];
    stopped = false;
    borrow = true; // when a job's own keys are all used up, let other keys help
    waitingMsg = ""; // shown in the UI while every key is cooling down
    onChange: () => void = () => {};

    constructor() {
        // Server mode: keys come from Render env vars (never from the browser).
        // AI_KEYS (any job) | AI_KEYS_WRITE | AI_KEYS_REVIEW | AI_KEYS_PICS: separated by newlines, commas or spaces.
        for (const [env, role] of [["AI_KEYS", "any"], ["AI_KEYS_WRITE", "write"], ["AI_KEYS_REVIEW", "review"], ["AI_KEYS_PICS", "pics"]] as [string, Role][])
            if (process.env[env]) this.addKeys(process.env[env]!, role);
        this.borrow = process.env.AI_BORROW !== "0";
    }
    static fromEnv(): KeyPool { return new KeyPool(); }
    private save() { this.onChange(); }
    saveSettings() { this.save(); }

    /** Adds keys (one per line, or separated by commas/spaces) for a job. Known keys just get the new job. */
    addKeys(text: string, role: Role): number {
        const list = [...new Set(text.split(/[\n,;\s]+/).map((x) => x.trim()).filter((x) => x.length > 8))];
        let added = 0;
        for (const key of list) {
            const k = this.keys.find((x) => x.key === key);
            if (k) k.role = role;
            else { this.keys.push({ key, role, until: 0, dead: false, reason: "", ok: 0, last: 0 }); added++; }
        }
        this.save();
        return added;
    }
    setRole(k: PoolKey, role: Role) { k.role = role; this.save(); }
    remove(k: PoolKey) { this.keys = this.keys.filter((x) => x !== k); this.save(); }
    reviveAll() {
        this.keys.forEach((k) => { k.until = 0; k.dead = false; k.reason = ""; });
        this.save();
    }
    usable() {
        const now = Date.now();
        return this.keys.filter((k) => !k.dead && k.until <= now);
    }
    first(): string {
        return (this.usable()[0] ?? this.keys.find((k) => !k.dead))?.key ?? "";
    }
    state(k: PoolKey): "ready" | "cooling" | "dead" {
        return k.dead ? "dead" : k.until > Date.now() ? "cooling" : "ready";
    }

    /** Keys allowed to take this job, best group first: its own keys, then "any" keys, then (optionally) the rest. */
    private candidates(u: PoolKey[], opts?: RunOpts): PoolKey[] {
        if (opts?.only) u = u.filter((k) => opts.only!(k.key));
        else if (opts?.prefer) { const p = u.filter((k) => opts.prefer!(k.key)); if (p.length) u = p; }
        const role = opts?.role;
        if (!role) return u;
        const own = u.filter((k) => k.role === role);
        if (own.length) return own;
        const any = u.filter((k) => k.role === "any");
        if (any.length) return any;
        return this.borrow ? u : [];
    }
    private pick(opts?: RunOpts): PoolKey | undefined {
        return this.candidates(this.usable(), opts).sort((a, b) => a.last - b.last)[0]; // least recently used first = fair spread
    }

    private classify(k: PoolKey, e: any) {
        const status = Number(e?.status) || 0;
        const msg = String(e?.message || e);
        const now = Date.now();
        if (status === 401 || status === 403 || /api[_ ]?key.*(invalid|not valid|expired)|invalid x-api-key|unauthorized|leaked|permission.denied/i.test(msg)) {
            k.dead = true;
            k.reason = "Invalid or blocked key";
        } else if (status === 402 || /billing|credit balance|insufficient/i.test(msg)) {
            k.until = now + 6 * 3600e3;
            k.reason = "No credit left";
        } else if (status === 429 || /quota|rate.?limit|resource.?exhausted/i.test(msg)) {
            const daily = /per day|daily|PerDay|exceeded your current quota|billing/i.test(msg);
            k.until = now + (daily ? 6 * 3600e3 : 70e3);
            k.reason = daily ? "Daily limit reached" : "Rate limit (short pause)";
        } else {
            k.until = now + 20e3; // busy / network hiccup
            k.reason = "Service busy, retrying";
        }
        this.save();
    }

    /** Runs fn with a working key. Switches keys on errors. Throws PoolExhausted when no key can work soon. */
    async run<T>(fn: (key: string) => Promise<T>, maxWaitMs = 120e3, opts?: RunOpts): Promise<T> {
        let failures = 0;
        for (;;) {
            if (this.stopped) throw new PoolStopped("Stopped");
            const k = this.pick(opts);
            if (!k) {
                const eligible = this.candidates(this.keys.filter((x) => !x.dead), opts);
                if (!eligible.length) {
                    throw new PoolExhausted(opts?.only && !this.keys.some((x) => !x.dead && opts.only!(x.key))
                        ? opts.onlyMsg || "No suitable key for this step."
                        : "No working API key left for this job. Add keys, or turn on 'borrow' so other keys can help.");
                }
                const wait = Math.min(...eligible.map((x) => x.until)) - Date.now();
                if (wait > maxWaitMs) throw new PoolExhausted("Every key for this job reached its limit. Add keys, or resume later when a limit resets.");
                for (let left = Math.ceil(wait / 1000); left > 0 && !this.stopped; left--) {
                    this.waitingMsg = `All keys for this job are cooling down. Waiting ${left}s…`;
                    this.onChange();
                    await sleep(1000);
                }
                this.waitingMsg = "";
                this.onChange();
                continue;
            }
            k.last = Date.now();
            try {
                const r = await fn(k.key);
                k.ok++;
                this.save();
                return r;
            } catch (e: any) {
                if (this.stopped) throw new PoolStopped("Stopped");
                this.classify(k, e);
                if (++failures > Math.max(8, this.keys.length * 2 + 4)) throw e;
            }
        }
    }
}

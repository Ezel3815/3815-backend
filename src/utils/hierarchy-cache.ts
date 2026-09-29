// Caches the heavy /decks/hierarchy result per user for a short time and makes
// simultaneous requests share ONE database query instead of each taking a
// connection. Cleared whenever the user's progress changes.
const TTL_MS = 60_000;

type Entry = { at: number; data: any };
const cache = new Map<number, Entry>();
const inFlight = new Map<number, Promise<any>>();
const generation = new Map<number, number>();

export async function cachedHierarchy(
    userId: number,
    load: () => Promise<any>,
): Promise<any> {
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

    const running = inFlight.get(userId);
    if (running) return running;

    const gen = generation.get(userId) ?? 0;
    const p = load()
        .then((data) => {
            // only keep it if nothing changed while we were loading
            if ((generation.get(userId) ?? 0) === gen) {
                cache.set(userId, { at: Date.now(), data });
            }
            return data;
        })
        .finally(() => inFlight.delete(userId));
    inFlight.set(userId, p);
    return p;
}

export function invalidateHierarchy(userId?: number) {
    if (userId === undefined) {
        cache.clear();
        for (const k of generation.keys()) generation.set(k, (generation.get(k) ?? 0) + 1);
        return;
    }
    cache.delete(userId);
    generation.set(userId, (generation.get(userId) ?? 0) + 1);
}

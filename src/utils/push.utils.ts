import * as admin from "firebase-admin";
import { PrismaService } from "nestjs-prisma";

/// Push notifications for events that should reach a user OUTSIDE the
/// app (a friend followed someone, a friend unlocked an achievement) —
/// separate from the in-app Feed, which already shows these as posts.
///
/// Configured the same way cloudinary is in files.utils.ts: plain
/// process.env, no config module. FIREBASE_SERVICE_ACCOUNT holds the
/// full service-account JSON, base64-encoded (so it's one safe
/// env-var value, not a multi-line secret with quoting problems).
///
/// If the env var isn't set, every function here becomes a no-op —
/// the rest of the app (follow, achievements, the Feed) keeps working
/// exactly as before push notifications existed.
let app: admin.app.App | null = null;

function getApp(): admin.app.App | null {
    if (app) return app;
    const encoded = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!encoded) {
        console.warn(
            "FIREBASE_SERVICE_ACCOUNT not set — push notifications are disabled.",
        );
        return null;
    }
    try {
        const json = Buffer.from(encoded, "base64").toString("utf8");
        const serviceAccount = JSON.parse(json);
        app = admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        return app;
    } catch (e) {
        console.error("Failed to initialize Firebase Admin:", e);
        return null;
    }
}

/// Runs a notification job WITHOUT making the caller wait for it. Sending
/// through Firebase can take seconds (cold start, many followers); doing it
/// inside the request made "follow" and "answer card" feel frozen. Errors are
/// logged, never thrown.
export function runInBackground(job: () => Promise<unknown>) {
    void job().catch((e) => console.error("Background push job failed:", e));
}

/// Whether the server can talk to Firebase at all (env var present and valid).
export function isPushConfigured(): boolean {
    return getApp() !== null;
}

/// Like sendPushToToken but REPORTS what happened (used by the push self-test,
/// so a failure is visible instead of silently swallowed).
export async function sendPushDetailed(
    token: string,
    title: string,
    body: string,
    data?: Record<string, string>,
): Promise<{ ok: boolean; error?: string }> {
    const firebaseApp = getApp();
    if (!firebaseApp) return { ok: false, error: "firebase_not_configured" };
    try {
        await firebaseApp.messaging().send({
            token,
            notification: { title, body },
            data,
            android: { priority: "high" },
        });
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: e?.errorInfo?.code ?? e?.code ?? String(e) };
    }
}

/// Sends a single push notification to one device token. Never throws —
/// a push failing (stale token, no credentials, network hiccup) must
/// never break the request that triggered it (following someone,
/// answering a card). Logs and swallows instead.
/// Product rule: a user only gets a push when someone follows THEM or sends them
/// a challenge (plus the self-test). Everything else (friends' achievements,
/// friends following others, reminders...) stays silent. Add a type here to
/// turn a kind of push back on.
const ALLOWED_PUSH_TYPES = new Set(["followed", "challenge_invite", "push_test"]);

function isPushAllowed(data?: Record<string, string>): boolean {
    return !!data?.type && ALLOWED_PUSH_TYPES.has(data.type);
}

export async function sendPushToToken(
    token: string,
    title: string,
    body: string,
    data?: Record<string, string>,
) {
    if (!isPushAllowed(data)) return;
    const firebaseApp = getApp();
    if (!firebaseApp) return;
    try {
        await firebaseApp.messaging().send({
            token,
            notification: { title, body },
            data,
            android: { priority: "high" },
        });
    } catch (e: any) {
        // A token that's stale/uninstalled is expected and not worth
        // logging loudly — anything else is worth knowing about.
        const code = e?.errorInfo?.code ?? e?.code;
        if (
            code !== "messaging/registration-token-not-registered" &&
            code !== "messaging/invalid-registration-token"
        ) {
            console.error("Push send failed:", e);
        }
    }
}

/// Looks up the user's saved FCM token and sends to it, if present.
export async function sendPushToUser(
    prisma: PrismaService,
    userId: number,
    title: string,
    body: string,
    data?: Record<string, string>,
) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { fcm_token: true },
    });
    const token = user?.fcm_token;
    if (!token) {
        console.log(`Push skipped: user ${userId} has no fcm_token saved (app never registered one).`);
        return;
    }
    await sendPushToToken(token, title, body, data);
}

/// Pushes to everyone who follows `actorId` — for events a friend
/// should hear about outside the app even though they weren't
/// personally targeted (a followed person unlocking an achievement,
/// or following someone new). Mirrors what the in-app "friends
/// activity" feed already shows those same followers.
export async function sendPushToFollowers(
    prisma: PrismaService,
    actorId: number,
    title: string,
    body: string,
    data?: Record<string, string>,
) {
    if (!getApp() || !isPushAllowed(data)) return; // skip the query entirely
    const [followers, actor] = await Promise.all([
        prisma.follow.findMany({
            where: { followingId: actorId },
            select: { follower: { select: { fcm_token: true } } },
        }),
        prisma.user.findUnique({
            where: { id: actorId },
            select: { fcm_token: true },
        }),
    ]);
    // One push per DEVICE: several accounts logged in on the same phone share
    // a token, which used to send the same notification N times — and never
    // notify the actor's own device about their own activity.
    const tokens = [
        ...new Set(
            followers
                .map((f) => f.follower.fcm_token)
                .filter((t): t is string => !!t && t !== actor?.fcm_token),
        ),
    ];
    await Promise.all(tokens.map((t) => sendPushToToken(t, title, body, data)));
}

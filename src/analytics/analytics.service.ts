import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "nestjs-prisma";

/**
 * Admin analytics: retention, usage, funnel, content, money. Read-only, MySQL 8.
 *
 * WHAT COUNTS AS "ACTIVE": a user is active on a local day when they answered a card that day.
 * The app has no session / app-open log, and CardAnswer keeps ONE row per (user, card): created_at = the first
 * answer, updated_at = the LATEST answer. So the days a card was re-reviewed in between are invisible and
 * activity is slightly UNDER-counted (never over-counted). Every number here is therefore a floor.
 *
 * All SQL below is built from server-generated dates and a clamped integer time-zone offset only (no user text).
 */

const U = "`User`";
const clampTz = (v: any) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(-12, Math.min(14, n)) : 3; };
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };

function clean(v: any): any {
    if (typeof v === "bigint") return Number(v);
    if (v instanceof Date) return v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0 ? ymd(v) : v.toISOString();
    if (v && typeof v === "object" && typeof v.toNumber === "function") return v.toNumber();
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
    return v;
}

// [key, first day, last day] after the signup day. d* = exactly on that day, w* = at least once in that 7-day window.
const METRICS: [string, number, number][] = [
    ["d1", 1, 1], ["d3", 3, 3], ["d7", 7, 7], ["d14", 14, 14], ["d30", 30, 30],
    ["w1", 7, 13], ["w2", 14, 20], ["w3", 21, 27], ["w4", 28, 34], ["w6", 42, 48], ["w8", 56, 62],
];

@Injectable()
export class AnalyticsService {
    private readonly logger = new Logger("Analytics");
    private cache = new Map<number, { at: number; data: any }>();
    constructor(private prisma: PrismaService) {}

    private q(sql: string): Promise<any[]> { return this.prisma.$queryRawUnsafe<any[]>(sql).then((r) => clean(r)); }

    /** distinct (user, local day) pairs on which the user answered a card */
    private act(tz: number) {
        return `SELECT DISTINCT x.user_id, DATE(DATE_ADD(x.ts, INTERVAL ${tz} HOUR)) AS d
            FROM (SELECT user_id, created_at AS ts FROM CardAnswer UNION ALL SELECT user_id, updated_at AS ts FROM CardAnswer) x
            JOIN ${U} us ON us.id = x.user_id AND us.role = 'USER'`;
    }

    private retention(tz: number, anchor: string, grp: string, since: string, extraCte = "", extraJoin = "") {
        const cols = METRICS.map(([k, lo, hi]) =>
            `COUNT(DISTINCT CASE WHEN DATEDIFF(a.d, u.sd) BETWEEN ${lo} AND ${hi} THEN u.id END) AS r_${k},
             COUNT(DISTINCT CASE WHEN DATE_ADD(u.sd, INTERVAL ${hi} DAY) <= '${anchor}' THEN u.id END) AS e_${k}`).join(",\n");
        return `WITH act AS (${this.act(tz)}),
            u AS (SELECT id, study_year, fcm_token, DATE(DATE_ADD(created_at, INTERVAL ${tz} HOUR)) AS sd FROM ${U} WHERE role = 'USER' AND created_at >= '${since} 00:00:00')${extraCte}
            SELECT ${grp} AS grp, COUNT(DISTINCT u.id) AS size, COUNT(DISTINCT CASE WHEN a.d = u.sd THEN u.id END) AS day0, ${cols}
            FROM u ${extraJoin} LEFT JOIN act a ON a.user_id = u.id GROUP BY grp ORDER BY grp`;
    }

    async report(tzRaw: any, refresh: boolean) {
        const tz = clampTz(tzRaw);
        const hit = this.cache.get(tz);
        if (!refresh && hit && Date.now() - hit.at < 10 * 60_000) return hit.data;

        const today = ymd(new Date(Date.now() + tz * 3600_000)); // local "today" for the app's users
        const anchor = addDays(today, -1); // last COMPLETE day: today is still in progress
        const t0 = Date.now();
        const timings: Record<string, number> = {};
        const safe = async <T>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> => {
            const s = Date.now();
            try { return await fn(); }
            catch (e: any) { this.logger.error(`${name}: ${String(e?.message || e)}`); return { error: String(e?.message || e).slice(0, 300) }; }
            finally { timings[name] = Date.now() - s; }
        };
        const w30 = addDays(anchor, -29), w60 = addDays(anchor, -59);
        const act = this.act(tz);
        const dt = (d: string) => `'${d} 00:00:00'`;

        const out: any = { generatedAt: new Date().toISOString(), tz, anchor, today };

        out.overview = await safe("overview", async () => (await this.q(`SELECT
            (SELECT COUNT(*) FROM ${U} WHERE role = 'USER') AS total_users,
            (SELECT COUNT(*) FROM ${U} WHERE role = 'USER' AND status = 'ACTIVE') AS verified_users,
            (SELECT COUNT(DISTINCT ca.user_id) FROM CardAnswer ca JOIN ${U} us ON us.id = ca.user_id AND us.role = 'USER') AS users_who_studied,
            (SELECT COUNT(*) FROM CardAnswer ca JOIN ${U} us ON us.id = ca.user_id AND us.role = 'USER') AS card_answers,
            (SELECT COUNT(*) FROM ${U} WHERE role = 'USER' AND created_at >= ${dt(addDays(anchor, -6))}) AS signups_7d,
            (SELECT COUNT(*) FROM ${U} WHERE role = 'USER' AND created_at >= ${dt(w30)}) AS signups_30d,
            (SELECT COUNT(*) FROM ${U} WHERE role = 'USER' AND created_at >= ${dt(w60)} AND created_at < ${dt(w30)}) AS signups_prev30d,
            (SELECT MIN(created_at) FROM ${U} WHERE role = 'USER') AS first_signup`))[0]);

        out.active = await safe("active", async () => {
            const [row] = await this.q(`WITH act AS (${act}) SELECT
                COUNT(DISTINCT CASE WHEN d = '${anchor}' THEN user_id END) AS dau,
                COUNT(DISTINCT CASE WHEN d >= '${addDays(anchor, -6)}' THEN user_id END) AS wau,
                COUNT(DISTINCT user_id) AS mau FROM act WHERE d BETWEEN '${w30}' AND '${anchor}'`);
            const [prev] = await this.q(`WITH act AS (${act}) SELECT COUNT(DISTINCT user_id) AS mau_prev FROM act WHERE d BETWEEN '${w60}' AND '${addDays(w30, -1)}'`);
            const [mixed] = await this.q(`WITH act AS (${act}) SELECT
                COUNT(DISTINCT CASE WHEN us.created_at >= ${dt(w30)} THEN a.user_id END) AS mau_new
                FROM act a JOIN ${U} us ON us.id = a.user_id WHERE a.d BETWEEN '${w30}' AND '${anchor}'`);
            const series = await this.q(`WITH act AS (${act}) SELECT d, COUNT(*) AS dau FROM act WHERE d BETWEEN '${addDays(anchor, -59)}' AND '${anchor}' GROUP BY d ORDER BY d`);
            const avgDau30 = series.filter((s: any) => s.d >= w30).reduce((n: number, s: any) => n + s.dau, 0) / 30;
            return { ...row, ...prev, ...mixed, avg_dau_30d: Math.round(avgDau30 * 10) / 10, stickiness: row.mau ? Math.round((avgDau30 / row.mau) * 1000) / 10 : 0, series };
        });

        out.cohorts = await safe("cohorts", async () => this.q(this.retention(tz, anchor, "DATE_SUB(u.sd, INTERVAL WEEKDAY(u.sd) DAY)", addDays(anchor, -111))));
        out.byYear = await safe("byYear", async () => this.q(this.retention(tz, anchor, "COALESCE(u.study_year, 'unknown')", addDays(anchor, -119))));
        out.byPush = await safe("byPush", async () => this.q(this.retention(tz, anchor, "IF(u.fcm_token IS NULL, 'notifications off', 'notifications on')", addDays(anchor, -119))));
        out.firstDay = await safe("firstDay", async () => this.q(this.retention(tz, anchor,
            "CASE WHEN f.c IS NULL THEN '0 cards' WHEN f.c < 10 THEN '1-9 cards' WHEN f.c < 30 THEN '10-29 cards' ELSE '30+ cards' END", addDays(anchor, -119),
            `, f AS (SELECT ca.user_id, COUNT(*) AS c FROM CardAnswer ca JOIN u ON u.id = ca.user_id WHERE DATE(DATE_ADD(ca.created_at, INTERVAL ${tz} HOUR)) = u.sd GROUP BY ca.user_id)`,
            "LEFT JOIN f ON f.user_id = u.id")));

        out.funnel = await safe("funnel", async () => (await this.q(`WITH act AS (${act}),
            u AS (SELECT id, status, created_at, DATE(DATE_ADD(created_at, INTERVAL ${tz} HOUR)) AS sd FROM ${U} WHERE role = 'USER' AND created_at >= ${dt(addDays(anchor, -89))} AND created_at < ${dt(addDays(anchor, -13))}),
            fa AS (SELECT user_id, MIN(created_at) AS first_at FROM CardAnswer GROUP BY user_id),
            wk AS (SELECT u.id, COUNT(DISTINCT a.d) AS days7 FROM u JOIN act a ON a.user_id = u.id AND DATEDIFF(a.d, u.sd) BETWEEN 0 AND 6 GROUP BY u.id),
            wk2 AS (SELECT u.id FROM u JOIN act a ON a.user_id = u.id AND DATEDIFF(a.d, u.sd) BETWEEN 7 AND 13 GROUP BY u.id)
            SELECT COUNT(*) AS signed_up,
              SUM(u.status = 'ACTIVE') AS verified,
              SUM(EXISTS (SELECT 1 FROM UserDeck ud WHERE ud.user_id = u.id)) AS linked_deck,
              SUM(fa.first_at IS NOT NULL) AS studied,
              SUM(fa.first_at IS NOT NULL AND TIMESTAMPDIFF(MINUTE, u.created_at, fa.first_at) <= 60) AS studied_1h,
              SUM(fa.first_at IS NOT NULL AND TIMESTAMPDIFF(MINUTE, u.created_at, fa.first_at) <= 1440) AS studied_24h,
              SUM(COALESCE(wk.days7, 0) >= 2) AS days2_first_week,
              SUM(COALESCE(wk.days7, 0) >= 3) AS days3_first_week,
              SUM(wk2.id IS NOT NULL) AS back_in_week2
            FROM u LEFT JOIN fa ON fa.user_id = u.id LEFT JOIN wk ON wk.id = u.id LEFT JOIN wk2 ON wk2.id = u.id`))[0]);

        out.lifecycle = await safe("lifecycle", async () => this.q(`WITH act AS (${act}), la AS (SELECT user_id, MAX(d) AS last_d FROM act GROUP BY user_id)
            SELECT CASE WHEN la.last_d IS NULL AND u.created_at >= ${dt(addDays(anchor, -6))} THEN 'new, not yet studied'
                        WHEN la.last_d IS NULL THEN 'never studied'
                        WHEN DATEDIFF('${anchor}', la.last_d) <= 6 THEN 'active (last 7 days)'
                        WHEN DATEDIFF('${anchor}', la.last_d) <= 13 THEN 'cooling (8-14 days)'
                        WHEN DATEDIFF('${anchor}', la.last_d) <= 29 THEN 'lapsed (15-30 days)'
                        ELSE 'gone (30+ days)' END AS segment, COUNT(*) AS users
            FROM ${U} u LEFT JOIN la ON la.user_id = u.id WHERE u.role = 'USER' GROUP BY segment`));

        out.usage = await safe("usage", async () => {
            const buckets = await this.q(`WITH act AS (${act}), per AS (SELECT user_id, COUNT(*) AS days FROM act WHERE d BETWEEN '${w30}' AND '${anchor}' GROUP BY user_id)
                SELECT CASE WHEN days = 1 THEN '1 day' WHEN days <= 3 THEN '2-3 days' WHEN days <= 7 THEN '4-7 days' WHEN days <= 14 THEN '8-14 days' WHEN days <= 21 THEN '15-21 days' ELSE '22+ days' END AS bucket,
                COUNT(*) AS users, SUM(days) AS user_days FROM per GROUP BY bucket`);
            const per = await this.q(`SELECT ca.user_id, COUNT(*) AS c FROM CardAnswer ca JOIN ${U} us ON us.id = ca.user_id AND us.role = 'USER' WHERE ca.updated_at >= ${dt(w30)} GROUP BY ca.user_id`);
            const c = per.map((x: any) => x.c as number).sort((a: number, b: number) => a - b);
            const total = c.reduce((n: number, x: number) => n + x, 0);
            const top = c.slice(Math.floor(c.length * 0.9));
            const pct = (p: number) => (c.length ? c[Math.min(c.length - 1, Math.floor(c.length * p))] : 0);
            return {
                buckets, users: c.length, cards_window: total, median_cards: pct(0.5), p90_cards: pct(0.9),
                top10_share: total ? Math.round((top.reduce((n: number, x: number) => n + x, 0) / total) * 1000) / 10 : 0,
            };
        });

        out.timing = await safe("timing", async () => {
            const rows = await this.q(`SELECT HOUR(DATE_ADD(ca.updated_at, INTERVAL ${tz} HOUR)) AS h, DAYOFWEEK(DATE_ADD(ca.updated_at, INTERVAL ${tz} HOUR)) AS dow, COUNT(*) AS c
                FROM CardAnswer ca JOIN ${U} us ON us.id = ca.user_id AND us.role = 'USER' WHERE ca.updated_at >= ${dt(w30)} GROUP BY h, dow`);
            const hours = Array(24).fill(0), dows = Array(7).fill(0);
            for (const r of rows) { hours[r.h] += r.c; dows[r.dow - 1] += r.c; } // dow 0 = Sunday
            return { hours, dows };
        });

        out.notifications = await safe("notifications", async () => ({
            types: await this.q(`SELECT notification_type, notification_pool, COUNT(*) AS sent,
                SUM(opened_at IS NOT NULL OR app_opened_after_notification = 1) AS opened, SUM(studied_after_notification = 1) AS studied,
                SUM(notification_converted_to_study = 1) AS converted, ROUND(AVG(cards_completed_after_notification), 1) AS avg_cards
                FROM NotificationEvent WHERE sent_at >= ${dt(w30)} GROUP BY notification_type, notification_pool ORDER BY sent DESC LIMIT 20`),
            reach: (await this.q(`SELECT COUNT(*) AS users, SUM(fcm_token IS NOT NULL) AS with_token FROM ${U} WHERE role = 'USER'`))[0],
        }));

        out.features = await safe("features", async () => {
            const [r] = await this.q(`WITH act AS (${act}), recent AS (SELECT DISTINCT user_id FROM act WHERE d BETWEEN '${addDays(anchor, -13)}' AND '${anchor}'),
                base AS (SELECT u.id,
                    EXISTS (SELECT 1 FROM Follow f WHERE f.followerId = u.id) AS follows,
                    EXISTS (SELECT 1 FROM MosaicSeason m WHERE m.user_id = u.id) AS mosaic,
                    EXISTS (SELECT 1 FROM AiUsage a2 WHERE a2.user_id = u.id) AS ai_scan,
                    EXISTS (SELECT 1 FROM QuizAttempt q WHERE q.user_id = u.id) AS quiz,
                    EXISTS (SELECT 1 FROM UserAchievement x WHERE x.user_id = u.id) AS achievements,
                    (u.fcm_token IS NOT NULL) AS push,
                    (r.user_id IS NOT NULL) AS rec
                  FROM ${U} u LEFT JOIN recent r ON r.user_id = u.id WHERE u.role = 'USER' AND u.created_at < ${dt(addDays(anchor, -29))})
                SELECT COUNT(*) AS n, SUM(rec) AS rec_all,
                  SUM(follows) AS follows_n, SUM(follows AND rec) AS follows_rec, SUM(mosaic) AS mosaic_n, SUM(mosaic AND rec) AS mosaic_rec,
                  SUM(ai_scan) AS ai_scan_n, SUM(ai_scan AND rec) AS ai_scan_rec, SUM(quiz) AS quiz_n, SUM(quiz AND rec) AS quiz_rec,
                  SUM(achievements) AS achievements_n, SUM(achievements AND rec) AS achievements_rec, SUM(push) AS push_n, SUM(push AND rec) AS push_rec FROM base`);
            const names: Record<string, string> = { follows: "Follows a friend", mosaic: "Started a mosaic", ai_scan: "Used AI scan", quiz: "Took an AI quiz", achievements: "Unlocked an achievement", push: "Notifications on" };
            const rows = Object.keys(names).map((k) => {
                const n = r[`${k}_n`] ?? 0, rec = r[`${k}_rec`] ?? 0, rest = (r.n ?? 0) - n, restRec = (r.rec_all ?? 0) - rec;
                return { feature: names[k], with_users: n, with_active: n ? Math.round((rec / n) * 1000) / 10 : null, without_users: rest, without_active: rest ? Math.round((restRec / rest) * 1000) / 10 : null };
            });
            return { users: r.n, active_overall: r.n ? Math.round((r.rec_all / r.n) * 1000) / 10 : null, rows };
        });

        out.money = await safe("money", async () => ({
            ai: (await this.q(`SELECT (SELECT COUNT(DISTINCT user_id) FROM AiUsage) AS users_ever, (SELECT COUNT(*) FROM AiUsage WHERE created_at >= ${dt(w30)}) AS uses_30d,
                (SELECT COUNT(DISTINCT user_id) FROM AiUsage WHERE created_at >= ${dt(w30)}) AS users_30d,
                (SELECT COUNT(*) FROM AiSubscription WHERE expires_at > UTC_TIMESTAMP()) AS subs_active,
                (SELECT COUNT(*) FROM AiSubscription WHERE expires_at <= UTC_TIMESTAMP()) AS subs_expired,
                (SELECT COUNT(DISTINCT user_id) FROM QuizAttempt) AS quiz_users, (SELECT COUNT(*) FROM QuizAttempt WHERE created_at >= ${dt(w30)}) AS quiz_attempts_30d`))[0],
            plans: await this.q(`SELECT plan, source, COUNT(*) AS n FROM AiSubscription WHERE expires_at > UTC_TIMESTAMP() GROUP BY plan, source`),
            payments: await this.q(`SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_usd), 0) AS usd FROM AiPayment GROUP BY status`),
            revenue: await this.q(`SELECT DATE_FORMAT(COALESCE(reviewed_at, created_at), '%Y-%m') AS ym, COUNT(*) AS n, SUM(amount_usd) AS usd FROM AiPayment WHERE status = 'APPROVED' GROUP BY ym ORDER BY ym DESC LIMIT 6`),
        }));

        out.social = await safe("social", async () => this.q(`SELECT type, COUNT(*) AS c FROM ActivityEvent WHERE created_at >= ${dt(w30)} GROUP BY type ORDER BY c DESC LIMIT 12`));

        out.content = await safe("content", async () => {
            const base = `FROM CardAnswer ca JOIN Card c ON c.id = ca.card_id JOIN Deck d ON d.id = c.deck_id JOIN ${U} us ON us.id = ca.user_id AND us.role = 'USER'`;
            return {
                top: await this.q(`SELECT d.id, d.title, COUNT(DISTINCT ca.user_id) AS learners, COUNT(*) AS answers, ROUND(100 * SUM(ca.answer IN ('AGAIN', 'HARD')) / COUNT(*), 1) AS hard_pct,
                    (SELECT COUNT(*) FROM Card c2 WHERE c2.deck_id = d.id) AS cards ${base} GROUP BY d.id, d.title ORDER BY learners DESC LIMIT 15`),
                hardest: await this.q(`SELECT d.id, d.title, COUNT(DISTINCT ca.user_id) AS learners, COUNT(*) AS answers, ROUND(100 * SUM(ca.answer IN ('AGAIN', 'HARD')) / COUNT(*), 1) AS hard_pct
                    ${base} GROUP BY d.id, d.title HAVING COUNT(*) >= 100 ORDER BY hard_pct DESC LIMIT 10`),
                ignored: await this.q(`SELECT d.id, d.title, COUNT(c.id) AS cards FROM Deck d JOIN Card c ON c.deck_id = d.id
                    WHERE d.type = 'CARDS_DECK' AND d.by_admin = 1 AND d.visible = 1
                      AND NOT EXISTS (SELECT 1 FROM CardAnswer ca JOIN Card c3 ON c3.id = ca.card_id WHERE c3.deck_id = d.id)
                    GROUP BY d.id, d.title ORDER BY cards DESC LIMIT 15`),
            };
        });

        out.timings = { ...timings, total: Date.now() - t0 };
        this.cache.set(tz, { at: Date.now(), data: out });
        return out;
    }
}

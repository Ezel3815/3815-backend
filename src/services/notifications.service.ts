import { Injectable } from "@nestjs/common";
import { PrismaService } from "nestjs-prisma";
import { NotificationEventDto } from "src/dtos/notifications/notification-events.dto";
import { isSameUtcDay, startOfUtcDay } from "src/utils/date.utils";
import { isPushConfigured, sendPushDetailed } from "src/utils/push.utils";

@Injectable()
export class NotificationsService {
    constructor(private prismaService: PrismaService) {}

    /**
     * Server-authoritative study state for the reminder engine, so a user who
     * studied on another device (or whose local flag was lost) stops getting
     * reminders. Read-only; nothing here awards or changes anything.
     */
    async getState(userId: number) {
        const today = startOfUtcDay(new Date());
        const user = await this.prismaService.user.findUnique({
            where: { id: userId },
            select: { current_streak: true, last_study_date: true },
        });

        const reviewedToday = await this.prismaService.cardAnswer.count({
            where: { user_id: userId, updated_at: { gte: today } },
        });

        // "Due for review": answered before today and either not mastered
        // (HARD / AGAIN) or last seen 3+ days ago. There is no per-card
        // schedule in the data model, so this is the closest honest signal.
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
        const dueReviews = await this.prismaService.cardAnswer.count({
            where: {
                user_id: userId,
                updated_at: { lt: today },
                OR: [
                    { answer: { in: ["HARD", "AGAIN"] } },
                    { updated_at: { lt: threeDaysAgo } },
                ],
            },
        });

        const studiedToday =
            !!user?.last_study_date && isSameUtcDay(user.last_study_date, today);
        // The streak shown to users is only valid if they studied today or yesterday.
        const streak = user?.current_streak ?? 0;

        return {
            studied_today: studiedToday,
            reviewed_today: reviewedToday,
            due_reviews: dueReviews,
            streak,
            server_time: new Date().toISOString(),
        };
    }

    /**
     * Push self-test. Reports whether Firebase is configured on the server and
     * whether this account has a saved device token, then sends a real push
     * after `delaySeconds` (so the tester can close the app first).
     */
    async pushTest(userId: number, delaySeconds: number) {
        const user = await this.prismaService.user.findUnique({
            where: { id: userId },
            select: { fcm_token: true },
        });
        const configured = isPushConfigured();
        const hasToken = !!user?.fcm_token;
        const delay = Math.max(0, Math.min(30, delaySeconds || 0));
        let diagnosis = "will_send";
        if (!configured) diagnosis = "server_firebase_not_configured";
        else if (!hasToken) diagnosis = "no_device_token";
        if (configured && hasToken) {
            setTimeout(() => {
                void sendPushDetailed(
                    user!.fcm_token!,
                    "اختبار الإشعارات 🔔",
                    "وصلك هذا الإشعار من الخادم — الإشعارات الفورية تعمل ✅",
                    { type: "push_test" },
                ).then((r) => {
                    if (!r.ok) console.error("Push test failed:", r.error);
                });
            }, delay * 1000);
        }
        return {
            firebase_configured: configured,
            has_token: hasToken,
            diagnosis,
            delay_seconds: delay,
        };
    }

    /** Idempotent batch upsert of notification lifecycle records (keyed by client_id). */
    async recordEvents(userId: number, events: NotificationEventDto[]) {
        let saved = 0;
        for (const e of events.slice(0, 200)) {
            const sentAt = new Date(e.sent_at);
            if (isNaN(sentAt.getTime())) continue;
            const data = {
                notification_type: e.notification_type.slice(0, 40),
                notification_pool: e.notification_pool.slice(0, 40),
                message: e.message,
                sent_at: sentAt,
                opened_at: e.opened_at ? new Date(e.opened_at) : null,
                app_opened_after_notification:
                    e.app_opened_after_notification ?? false,
                studied_after_notification: e.studied_after_notification ?? false,
                study_session_started_at: e.study_session_started_at
                    ? new Date(e.study_session_started_at)
                    : null,
                cards_completed_after_notification:
                    e.cards_completed_after_notification ?? 0,
                notification_converted_to_study:
                    e.notification_converted_to_study ?? false,
                challenge_id: e.challenge_id ?? null,
                friend_id: e.friend_id ?? null,
            };
            // Keyed per user: two users can legitimately share a client_id.
            await this.prismaService.notificationEvent.upsert({
                where: {
                    user_id_client_id: { user_id: userId, client_id: e.client_id },
                },
                create: { client_id: e.client_id, user_id: userId, ...data },
                update: data,
            });
            saved++;
        }
        return { saved };
    }
}

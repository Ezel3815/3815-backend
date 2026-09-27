import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Prisma, User, UserRole, UserStatus } from "@prisma/client";
import { PrismaService } from "nestjs-prisma";
import { JwtConstant } from "src/constants/jwt.constant";
import { LoginDto } from "src/dtos/auth/login.dto";
import { RegisterDto } from "src/dtos/auth/register.dto";
import { FindQueryDto } from "src/dtos/find-query.dto";
import { CreateUserDto } from "src/dtos/users/create-user.dto";
import { UpdateMeDto } from "src/dtos/users/update-me.dto";
import { UpdatePasswordDto } from "src/dtos/users/update-password.dto";
import { UpdateUserDto } from "src/dtos/users/update-user.dto";
import { UpdateProfileDto } from "src/dtos/users/update-profile.dto";
import { UserOutDto, UserProfileOutDto } from "src/dtos/users/user.out-dto";
import { getLevelInfo } from "src/utils/level.utils";
import { startOfUtcDay, isSameUtcDay } from "src/utils/date.utils";
import { getAchievementsForUser } from "src/utils/achievement.utils";
import {
    claimQuestChest,
    getMutualFriendIds,
    getQuestsForUser,
} from "src/utils/quests.utils";
import { GenerateBadRequestException } from "src/exception/bad-request.exception";
import { GenerateUnauthorizedException } from "src/exception/unauthorized.exception";
import {
    runInBackground,
    sendPushToFollowers,
    sendPushToUser,
} from "src/utils/push.utils";
import { v7 as uuid } from "uuid";
import * as md5 from "md5";
import { MosaicService } from "../mosaic/mosaic.service";

// Feed events addressed to ONE person (shown only in that person's feed,
// no celebrate / comments): "X followed you" and "X reminds you to study".
const TARGETED_EVENT_TYPES = ["followed", "reminder", "challenge_invite"];

@Injectable()
export class UsersService {
    constructor(
        private prismaService: PrismaService,
        private mosaicService: MosaicService,
    ) {}

    async create(createUserDto: CreateUserDto) {
        const user = await this.prismaService.user.create({
            data: {
                name: createUserDto.name,
                email: createUserDto.email,
                password: md5(createUserDto.password),
                status: UserStatus.ACTIVE,
                role: createUserDto.role,
            },
        });
        return UserOutDto(user);
    }

    /// Finds people by name or username. People you already follow come
    /// first, then names that START with what was typed, then the rest —
    /// so a friend is never buried under (or cut off by) strangers who
    /// merely contain the same letters. Emails are never sent to the app.
    async searchUsers(query: string, requesterId: number) {
        const q = (query ?? "").trim();
        if (q.length === 0) return [];

        const [matches, follows] = await Promise.all([
            this.prismaService.user.findMany({
                where: {
                    id: { not: requesterId },
                    OR: [
                        { username: { contains: q } },
                        { name: { contains: q } },
                    ],
                },
                take: 200,
            }),
            this.prismaService.follow.findMany({
                where: { followerId: requesterId },
                select: { followingId: true },
            }),
        ]);

        const followingIds = new Set(follows.map((f) => f.followingId));
        const lower = q.toLowerCase();
        const rank = (u: User) => {
            const name = (u.name ?? "").toLowerCase();
            const username = (u.username ?? "").toLowerCase();
            const exact = name === lower || username === lower ? 0 : 1;
            const prefix =
                name.startsWith(lower) || username.startsWith(lower) ? 0 : 1;
            const followed = followingIds.has(u.id) ? 0 : 1;
            return [followed, exact, prefix];
        };

        return matches
            .sort((a, b) => {
                const ra = rank(a);
                const rb = rank(b);
                for (let i = 0; i < ra.length; i++) {
                    if (ra[i] !== rb[i]) return ra[i] - rb[i];
                }
                return (a.name ?? "").localeCompare(b.name ?? "");
            })
            .slice(0, 20)
            .map((u) => ({
                ...UserOutDto(u),
                email: "", // never expose other people's emails
                isFollowing: followingIds.has(u.id),
            }));
    }

    /// Ranks the requesting user together with everyone they follow, by
    /// total XP — the "friends leaderboard" for V2. Deliberately scoped
    /// to follows only (not a global leaderboard) per product decision.
    async getFriendsLeaderboard(userId: number) {
        const follows = await this.prismaService.follow.findMany({
            where: { followerId: userId },
            select: { followingId: true },
        });
        const ids = [userId, ...follows.map((f) => f.followingId)];

        const users = await this.prismaService.user.findMany({
            where: { id: { in: ids } },
        });

        const ranked = users
            .map((u) => ({
                id: u.id,
                name: u.name,
                username: u.username,
                avatar_hair: u.avatar_hair,
                xp: u.xp,
                level: getLevelInfo(u.xp).level,
                isMe: u.id === userId,
            }))
            .sort((a, b) => b.xp - a.xp);

        return ranked;
    }

    /// Fixed daily mission set for V1 — both grounded in data that's
    /// already tracked (no separate "missions" table needed yet).
    /// Resets naturally every day since it's computed from today's date,
    /// not stored/reset server-side.
    async getDailyMissions(userId: number) {
        const today = startOfUtcDay(new Date());

        const reviewsToday = await this.prismaService.cardAnswer.count({
            where: { user_id: userId, updated_at: { gte: today } },
        });

        const user = await this.prismaService.user.findUnique({
            where: { id: userId },
        });
        const streakMaintainedToday =
            !!user.last_study_date && isSameUtcDay(user.last_study_date, today);

        // BUG #8: this used to say 20 while the new daily quests (in
        // quests.utils.ts) target 10 for the exact same underlying count
        // (today's CardAnswer rows) — same UI showing two different
        // targets for the same fact. Aligned to 10 to match.
        const REVIEWS_TARGET = 10;

        return {
            date: today.toISOString().slice(0, 10),
            missions: [
                {
                    id: "daily_reviews",
                    title: `Complete ${REVIEWS_TARGET} reviews`,
                    progress: Math.min(reviewsToday, REVIEWS_TARGET),
                    target: REVIEWS_TARGET,
                    completed: reviewsToday >= REVIEWS_TARGET,
                },
                {
                    id: "maintain_streak",
                    title: "Maintain your streak",
                    progress: streakMaintainedToday ? 1 : 0,
                    target: 1,
                    completed: streakMaintainedToday,
                },
            ],
        };
    }

    // ───────────── Feed (own + followed users' activity) ─────────────

    private async assertFeedEventVisible(userId: number, eventId: number) {
        const event = await this.prismaService.activityEvent.findUnique({
            where: { id: eventId },
        });
        if (!event) GenerateBadRequestException(["Post not found"]);
        if (TARGETED_EVENT_TYPES.includes(event.type)) {
            // "X followed you" / "X reminded you" are only visible to the
            // person they are addressed to.
            if (event.target_user_id !== userId)
                GenerateBadRequestException(["Post not found"]);
        } else if (event.user_id !== userId) {
            const follows = await this.prismaService.follow.findFirst({
                where: { followerId: userId, followingId: event.user_id },
            });
            if (!follows) GenerateBadRequestException(["Post not found"]);
        }
        return event;
    }

    async getFeed(userId: number) {
        const follows = await this.prismaService.follow.findMany({
            where: { followerId: userId },
            select: { followingId: true },
        });
        const ids = [userId, ...follows.map((f) => f.followingId)];

        const events = await this.prismaService.activityEvent.findMany({
            where: {
                OR: [
                    // own + followed users' activity (follow events excluded:
                    // they are private notifications, see below)
                    { user_id: { in: ids }, type: { notIn: TARGETED_EVENT_TYPES } },
                    // "X followed you" / "X reminded you" — only for the
                    // person they are addressed to
                    { type: { in: TARGETED_EVENT_TYPES }, target_user_id: userId },
                ],
            },
            orderBy: { created_at: "desc" },
            take: 40,
            include: {
                user: true,
                _count: { select: { reactions: true, comments: true } },
                reactions: { where: { user_id: userId }, select: { user_id: true } },
            },
        });

        return events.map((e) => ({
            id: e.id,
            type: e.type,
            title: e.title,
            created_at: e.created_at,
            mine: e.user_id === userId,
            celebrations: e._count.reactions,
            comments: e._count.comments,
            celebrated: e.reactions.length > 0,
            user: {
                id: e.user.id,
                name: e.user.name,
                username: e.user.username,
                avatar_hair: e.user.avatar_hair,
            },
        }));
    }

    async toggleCelebrate(userId: number, eventId: number) {
        const event = await this.assertFeedEventVisible(userId, eventId);
        if (TARGETED_EVENT_TYPES.includes(event.type))
            GenerateBadRequestException(["You can't celebrate this post"]);
        if (event.user_id === userId)
            GenerateBadRequestException(["You can't celebrate your own post"]);

        const key = { event_id: eventId, user_id: userId };
        const existing = await this.prismaService.activityReaction.findUnique({
            where: { event_id_user_id: key },
        });
        if (existing) {
            await this.prismaService.activityReaction.delete({
                where: { event_id_user_id: key },
            });
        } else {
            try {
                await this.prismaService.activityReaction.create({ data: key });
            } catch (e: any) {
                if (e?.code !== "P2002") throw e; // double tap race: already there
            }
        }
        const count = await this.prismaService.activityReaction.count({
            where: { event_id: eventId },
        });
        return { celebrated: !existing, count };
    }

    private feedCommentOut(c: any) {
        return {
            id: c.id,
            text: c.text,
            created_at: c.created_at,
            user: {
                id: c.user.id,
                name: c.user.name,
                avatar_hair: c.user.avatar_hair,
            },
        };
    }

    async getFeedComments(userId: number, eventId: number) {
        await this.assertFeedEventVisible(userId, eventId);
        const rows = await this.prismaService.activityComment.findMany({
            where: { event_id: eventId },
            orderBy: { created_at: "asc" },
            take: 100,
            include: { user: true },
        });
        return rows.map((c) => this.feedCommentOut(c));
    }

    async addFeedComment(userId: number, eventId: number, text: string) {
        const target = await this.assertFeedEventVisible(userId, eventId);
        if (TARGETED_EVENT_TYPES.includes(target.type))
            GenerateBadRequestException(["You can't comment on this post"]);
        const clean = String(text ?? "").trim();
        if (clean.length < 1 || clean.length > 300)
            GenerateBadRequestException(["Comment must be 1-300 characters"]);
        const row = await this.prismaService.activityComment.create({
            data: { event_id: eventId, user_id: userId, text: clean },
            include: { user: true },
        });
        return this.feedCommentOut(row);
    }

    async getQuests(userId: number) {
        return await getQuestsForUser(this.prismaService, userId);
    }

    async claimQuestChest(userId: number, chestId: string) {
        // Mosaic weekly chests reuse this endpoint but have their own rules
        // (season day, cumulative requirements, piece budget).
        if (chestId.startsWith("mosaic_chest_"))
            return await this.mosaicService.claimChest(userId, chestId);
        const result = await claimQuestChest(
            this.prismaService,
            userId,
            chestId,
        );
        if (!result.ok) GenerateBadRequestException([result.message]);
        // Surface leveledUp/newLevel same as DecksCardsService.answer() does,
        // so the client can show the same level-up celebration either way —
        // the level_up activity event itself was already being created
        // correctly inside claimQuestChest regardless of this.
        return { xp: result.xp, leveledUp: result.leveledUp, newLevel: result.newLevel };
    }

    async getAchievements(userId: number) {
        return await getAchievementsForUser(this.prismaService, userId);
    }

    /// Recent notable moments from people you follow — chapter
    /// completions, level-ups, and achievement unlocks. This is what
    /// creates the "I'm not studying alone" effect on the home screen.
    /// Deliberately excludes your own events (that's what the
    /// celebration popups on your own client are for).
    async getFriendsActivityFeed(userId: number) {
        const follows = await this.prismaService.follow.findMany({
            where: { followerId: userId },
            select: { followingId: true },
        });
        const followingIds = follows.map((f) => f.followingId);
        if (followingIds.length === 0) return [];

        const events = await this.prismaService.activityEvent.findMany({
            where: {
                user_id: { in: followingIds },
                type: { notIn: TARGETED_EVENT_TYPES },
            },
            orderBy: { created_at: "desc" },
            take: 20,
            include: { user: true },
        });

        return events.map((e) => ({
            id: e.id,
            type: e.type,
            title: e.title,
            created_at: e.created_at,
            user: {
                id: e.user.id,
                name: e.user.name,
                username: e.user.username,
                avatar_hair: e.user.avatar_hair,
            },
        }));
    }
    

    async read(findQueryDto: FindQueryDto) {
        const users = await this.prismaService.user.findMany({
            skip: findQueryDto.skip,
            take: findQueryDto.limit,
            where: findQueryDto.filter ?? {},
            orderBy: findQueryDto.sort ?? { created_at: "desc" },
            include: { _count: true },
        });
        const count = await this.prismaService.user.count({
            where: findQueryDto.filter ?? {},
        });
        return {
            count: count,
            data: users.map(UserOutDto),
        };
    }

    async readOne(id: number) {
        const user = await this.prismaService.user.findUnique({
            where: { id },
        });
        return UserOutDto(user);
    }

    async getUserIdByUsername(username: string) {
        const user = await this.prismaService.user.findUnique({
            where: { username: username.trim().toLowerCase() },
            select: { id: true },
        });
        if (!user) GenerateBadRequestException(["User does not exist"]);
        return { id: user.id };
    }

    async getPublicProfileHtml(username: string) {
        const esc = (s: string) =>
            s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
        const user = await this.prismaService.user.findUnique({
            where: { username: username.toLowerCase() },
        });
        if (!user) GenerateBadRequestException(["User does not exist"]);
        const info = UserOutDto(user);
        const intent = `intent://u/${user.username}#Intent;scheme=mozaik;package=com.example.upgrade;end`;
        return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(user.name)} - MOZAIK</title>
<style>body{font-family:sans-serif;background:#f1f3e6;color:#1e2b22;text-align:center;padding:48px 20px}
.card{max-width:360px;margin:auto;background:#fff;border-radius:24px;padding:32px;box-shadow:0 4px 16px #0001}
b{color:#4f9d69}.open{display:inline-block;background:#4f9d69;color:#fff;padding:12px 22px;border-radius:14px;text-decoration:none}</style></head><body><div class="card"><h2>${esc(user.name)}</h2>
<p>@${esc(user.username ?? "")}</p><p>المستوى <b>${info.level}</b> · سلسلة <b>${info.current_streak}</b></p>
<p><a class="open" href="${intent}">افتح الملف في تطبيق MOZAIK</a></p>
<p><a href="mozaik://u/${esc(user.username ?? "")}">فتح بطريقة أخرى</a></p></div>
<script>setTimeout(function(){location.href=${JSON.stringify(intent)}},300)</script></body></html>`;
    }

    async getProfile(targetUserId: number, requestingUserId: number) {
        const user = await this.prismaService.user.findUnique({
            where: { id: targetUserId },
        });
        if (!user) GenerateBadRequestException(["User does not exist"]);

        const followersCount = await this.prismaService.follow.count({
            where: { followingId: targetUserId },
        });
        const followingCount = await this.prismaService.follow.count({
            where: { followerId: targetUserId },
        });

        const followingRecord = await this.prismaService.follow.findUnique({
            where: {
                followerId_followingId: {
                    followerId: requestingUserId,
                    followingId: targetUserId,
                },
            },
        });
        const isFollowing = !!followingRecord;

        let isFriend = false;
        if (isFollowing) {
            const reverseRecord = await this.prismaService.follow.findUnique({
                where: {
                    followerId_followingId: {
                        followerId: targetUserId,
                        followingId: requestingUserId,
                    },
                },
            });
            isFriend = !!reverseRecord;
        }

        const out = UserProfileOutDto(
            user,
            followersCount,
            followingCount,
            isFollowing,
            isFriend,
        );
        // Only you can see your own email.
        if (targetUserId !== requestingUserId) out.email = "";
        return out;
    }

    /// Saves (or clears, when token is null) this device's push token.
    /// Called on login and whenever Firebase hands the app a fresh
    /// token. One token per user — a second device simply overwrites
    /// the first, matching how the app currently has no multi-device
    /// concept anywhere else.
    async updateFcmToken(userId: number, token: string | null) {
        const clean = (token ?? "").trim();
        if (!clean) {
            await this.prismaService.user.update({
                where: { id: userId },
                data: { fcm_token: null },
            });
            return true;
        }
        // A device token belongs to one account (the one logged in on that
        // phone right now). Without this, every account ever used on the
        // phone kept the same token and received the same push again.
        await this.prismaService.$transaction([
            this.prismaService.user.updateMany({
                where: { fcm_token: clean, id: { not: userId } },
                data: { fcm_token: null },
            }),
            this.prismaService.user.update({
                where: { id: userId },
                data: { fcm_token: clean },
            }),
        ]);
        return true;
    }

    async follow(followerId: number, followingId: number) {
        if (followerId === followingId) {
            GenerateBadRequestException(["You can't follow yourself"]);
        }

        const targetUser = await this.prismaService.user.findUnique({
            where: { id: followingId },
        });
        if (!targetUser) GenerateBadRequestException(["User does not exist"]);

        const existing = await this.prismaService.follow.findUnique({
            where: {
                followerId_followingId: { followerId, followingId },
            },
        });
        if (existing) GenerateBadRequestException(["Already following this user"]);

        await this.prismaService.follow.create({
            data: { followerId, followingId },
        });

        // Notify the followed person in their Feed ("X followed you"). At
        // most one per pair per 24h so follow/unfollow spam can't flood it.
        const recent = await this.prismaService.activityEvent.findFirst({
            where: {
                user_id: followerId,
                target_user_id: followingId,
                type: "followed",
                created_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            },
        });
        if (!recent) {
            await this.prismaService.activityEvent.create({
                data: {
                    user_id: followerId,
                    target_user_id: followingId,
                    type: "followed",
                    title: "followed",
                },
            });
            // Outside-the-app notifications are sent in the BACKGROUND so the
            // follow request returns immediately (awaiting Firebase made the
            // follow button freeze for seconds).
            runInBackground(async () => {
                const follower = await this.prismaService.user.findUnique({
                    where: { id: followerId },
                    select: { name: true },
                });
                await sendPushToUser(
                    this.prismaService,
                    followingId,
                    "متابع جديد",
                    `بدأ ${follower?.name ?? "شخص ما"} بمتابعتك`,
                    { type: "followed", userId: String(followerId) },
                );
                // Also let the follower's OWN followers know — mirrors the
                // in-app "friends activity" feed, delivered outside it.
                await sendPushToFollowers(
                    this.prismaService,
                    followerId,
                    "نشاط صديق",
                    `${follower?.name ?? "صديقك"} بدأ بمتابعة ${targetUser?.name ?? "شخص جديد"}`,
                    { type: "friend_followed", userId: String(followerId) },
                );
            });
        }

        return true;
    }

    /// "Remind a friend to study": drops a private notification into the
    /// friend's Feed (type "reminder"). At most one per pair per 24h so it
    /// can't be used to spam someone. Returns { sent: false } (not an
    /// error) when today's reminder was already sent.
    async remind(senderId: number, targetId: number) {
        if (senderId === targetId) {
            GenerateBadRequestException(["You can't remind yourself"]);
        }

        const targetUser = await this.prismaService.user.findUnique({
            where: { id: targetId },
        });
        if (!targetUser) GenerateBadRequestException(["User does not exist"]);

        const follows = await this.prismaService.follow.findUnique({
            where: {
                followerId_followingId: {
                    followerId: senderId,
                    followingId: targetId,
                },
            },
        });
        if (!follows) {
            GenerateBadRequestException(["You can only remind people you follow"]);
        }

        const recent = await this.prismaService.activityEvent.findFirst({
            where: {
                user_id: senderId,
                target_user_id: targetId,
                type: "reminder",
                created_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            },
        });
        if (recent) return { sent: false, reason: "already_sent" };

        // Nothing to nudge if they've already studied today.
        const studiedToday =
            (await this.prismaService.cardAnswer.count({
                where: {
                    user_id: targetId,
                    updated_at: { gte: startOfUtcDay(new Date()) },
                },
            })) > 0;
        if (studiedToday) return { sent: false, reason: "already_studied" };

        await this.prismaService.activityEvent.create({
            data: {
                user_id: senderId,
                target_user_id: targetId,
                type: "reminder",
                title: "reminder",
            },
        });

        // A real notification outside the app too (sent in the background).
        runInBackground(async () => {
            const sender = await this.prismaService.user.findUnique({
                where: { id: senderId },
                select: { name: true },
            });
            await sendPushToUser(
                this.prismaService,
                targetId,
                "تذكير من صديق",
                `${sender?.name ?? "صديقك"} يذكّرك بالمذاكرة اليوم 📚`,
                { type: "reminder", userId: String(senderId) },
            );
        });
        return { sent: true };
    }

    /** Mutual friends the user can pick as their friends-quest partner. */
    async getQuestFriends(userId: number) {
        const ids = await getMutualFriendIds(this.prismaService, userId);
        if (ids.length === 0) return [];
        const [users, me] = await Promise.all([
            this.prismaService.user.findMany({ where: { id: { in: ids } } }),
            this.prismaService.user.findUnique({
                where: { id: userId },
                select: { quest_partner_id: true },
            }),
        ]);
        const byId = new Map(users.map((u) => [u.id, u]));
        return ids
            .filter((id) => byId.has(id))
            .map((id) => ({
                id,
                name: byId.get(id).name,
                username: byId.get(id).username,
                avatar_hair: byId.get(id).avatar_hair,
                is_partner: id === me?.quest_partner_id,
            }));
    }

    /** Choose who the friends quest is played with (must be a mutual friend). */
    async setQuestPartner(userId: number, friendId: number) {
        if (userId === friendId)
            GenerateBadRequestException(["Pick a friend, not yourself"]);
        const mutual = await getMutualFriendIds(this.prismaService, userId);
        if (!mutual.includes(friendId))
            GenerateBadRequestException([
                "You can only pick a friend who follows you back",
            ]);

        const me = await this.prismaService.user.findUnique({
            where: { id: userId },
            select: { quest_partner_id: true, name: true },
        });
        await this.prismaService.user.update({
            where: { id: userId },
            data: { quest_partner_id: friendId },
        });

        // Tell the friend they were invited (feed post + push), once a day.
        if (me?.quest_partner_id !== friendId) {
            const recent = await this.prismaService.activityEvent.findFirst({
                where: {
                    user_id: userId,
                    target_user_id: friendId,
                    type: "challenge_invite",
                    created_at: {
                        gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
                    },
                },
            });
            if (!recent) {
                await this.prismaService.activityEvent.create({
                    data: {
                        user_id: userId,
                        target_user_id: friendId,
                        type: "challenge_invite",
                        title: "challenge_invite",
                    },
                });
                runInBackground(() =>
                    sendPushToUser(
                        this.prismaService,
                        friendId,
                        "دعوة تحدٍّ",
                        `${me?.name ?? "صديقك"} دعاك لتحدي الأصدقاء هذا الأسبوع 🏆`,
                        { type: "challenge_invite", userId: String(userId) },
                    ),
                );
            }
        }
        return { ok: true };
    }

    /** People who follow `targetId` ("followers") or whom they follow ("following"). */
    async getFollowList(
        kind: "followers" | "following",
        targetId: number,
        viewerId: number,
    ) {
        const target = await this.prismaService.user.findUnique({
            where: { id: targetId },
            select: { id: true },
        });
        if (!target) GenerateBadRequestException(["User does not exist"]);

        const rows = await this.prismaService.follow.findMany({
            where:
                kind === "followers"
                    ? { followingId: targetId }
                    : { followerId: targetId },
            orderBy: { created_at: "desc" },
            take: 200,
            include: { follower: true, following: true },
        });
        const people = rows.map((r) => ({
            user: kind === "followers" ? r.follower : r.following,
            since: r.created_at,
        }));

        const iFollow = await this.prismaService.follow.findMany({
            where: {
                followerId: viewerId,
                followingId: { in: people.map((p) => p.user.id) },
            },
            select: { followingId: true },
        });
        const iFollowSet = new Set(iFollow.map((f) => f.followingId));

        return people.map((p) => ({
            id: p.user.id,
            name: p.user.name,
            username: p.user.username,
            avatar_hair: p.user.avatar_hair,
            since: p.since,
            is_me: p.user.id === viewerId,
            is_following: iFollowSet.has(p.user.id),
        }));
    }

    async unfollow(followerId: number, followingId: number) {
        await this.prismaService.follow.deleteMany({
            where: { followerId, followingId },
        });
        return true;
    }

    async updateProfile(userId: number, updateProfileDto: UpdateProfileDto) {
        if (updateProfileDto.username) {
            updateProfileDto.username = updateProfileDto.username
                .trim()
                .toLowerCase();
            const existing = await this.prismaService.user.findUnique({
                where: { username: updateProfileDto.username },
            });
            if (existing && existing.id !== userId) {
                GenerateBadRequestException(["Username already taken"]);
            }
        }

        const user = await this.prismaService.user.update({
            where: { id: userId },
            data: {
                username: updateProfileDto.username,
                avatar_hair: updateProfileDto.avatar_hair,
                avatar_hair_color: updateProfileDto.avatar_hair_color,
                avatar_skin_color: updateProfileDto.avatar_skin_color,
                avatar_clothing_color: updateProfileDto.avatar_clothing_color,
                avatar_glasses: updateProfileDto.avatar_glasses,
            },
        });

        return UserOutDto(user);
    }

    async update(id: number, updateUserDto: UpdateUserDto) {
        const user = await this.prismaService.user.update({
            where: {
                id,
            },
            data: {
                name: updateUserDto.name,
                status: updateUserDto.status,
            },
        });
        if (!user) GenerateBadRequestException(["User does not exist"]);
        return UserOutDto(user);
    }

    async updateMe(userId: number, updateMeDto: UpdateMeDto) {
        const user = await this.prismaService.user.update({
            where: {
                id: userId,
            },
            data: {
                name: updateMeDto.name,
            },
        });
        return UserOutDto(user);
    }

    async updateMyPassword(
        userId: number,
        updatePasswordDto: UpdatePasswordDto,
    ) {
        const user = await this.prismaService.user.findFirst({
            where: {
                id: userId,
                password: md5(updatePasswordDto.old_password),
            },
        });
        if (!user) GenerateBadRequestException(["Wrong password"]);
        return UserOutDto(
            await this.prismaService.user.update({
                where: {
                    id: user.id,
                },
                data: {
                    password: md5(updatePasswordDto.new_password),
                },
            }),
        );
    }

    // Deletes a user and everything in other tables that references them.
    // Decks are NOT deleted here: this schema has no owner_id on Deck —
    // access/ownership is entirely through the UserDeck join table (a deck
    // can be shared/public/attached via a Code to many users), so only
    // this user's UserDeck rows (their access) are removed. A deck that
    // was personal and never shared becomes orphaned (inaccessible) but
    // stays in the DB — see the fix notes if you want that changed.
    async delete(id: number) {
        const user = await this.prismaService.user.findUnique({ where: { id } });
        if (!user) GenerateBadRequestException(["User does not exist"]);

        await this.prismaService.$transaction([
            // 1. this user's own reactions/comments on OTHER people's events
            //    (reactions/comments on events being deleted below are
            //    handled automatically by the schema's onDelete: Cascade
            //    on ActivityReaction/ActivityComment -> ActivityEvent)
            this.prismaService.activityReaction.deleteMany({ where: { user_id: id } }),
            this.prismaService.activityComment.deleteMany({ where: { user_id: id } }),

            // 2. events this user authored or was the target of ("X
            //    followed you", "X reminded you")
            this.prismaService.activityEvent.deleteMany({
                where: { OR: [{ user_id: id }, { target_user_id: id }] },
            }),

            // 3. achievements
            this.prismaService.userAchievement.deleteMany({ where: { user_id: id } }),

            // 4. study history
            this.prismaService.cardAnswer.deleteMany({ where: { user_id: id } }),

            // 5. social graph, both directions
            this.prismaService.follow.deleteMany({
                where: { OR: [{ followerId: id }, { followingId: id }] },
            }),

            // 6. this user's deck access/edit rights (see note above the method)
            this.prismaService.userDeck.deleteMany({ where: { user_id: id } }),

            // 7. quest_partner_id has no DB-level foreign key in this schema
            //    (plain Int?, no @relation), so it can't block the delete —
            //    but clear it anyway so no other user points at a deleted id
            this.prismaService.user.updateMany({
                where: { quest_partner_id: id },
                data: { quest_partner_id: null },
            }),

            // 8. finally the user
            this.prismaService.user.delete({ where: { id } }),
        ]);

        return true;
    }
}

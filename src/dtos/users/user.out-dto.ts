import { User } from "@prisma/client";
import { getLevelInfo } from "src/utils/level.utils";
import { isSameUtcDay, isYesterday, startOfUtcDay } from "src/utils/date.utils";

/// READ-ONLY view of the streak. The stored current_streak is only rewritten
/// the next time the user studies, so after a missed day it would keep showing
/// the old number. This applies the same rule updateStreak uses (studied today
/// or yesterday keeps it, anything older has broken it) without writing
/// anything and without touching rewards/mosaic.
function effectiveStreak(user: User): number {
    if (!user.last_study_date) return user.current_streak;
    const today = startOfUtcDay(new Date());
    if (
        isSameUtcDay(user.last_study_date, today) ||
        isYesterday(user.last_study_date, today)
    ) {
        return user.current_streak;
    }
    return 0;
}

export function UserOutDto(user: User) {
    const levelInfo = getLevelInfo(user.xp);
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
        username: user.username,
        avatar_hair: user.avatar_hair,
        avatar_hair_color: user.avatar_hair_color,
        avatar_skin_color: user.avatar_skin_color,
        avatar_clothing_color: user.avatar_clothing_color,
        avatar_glasses: user.avatar_glasses,
        current_streak: effectiveStreak(user),
        study_year: user.study_year,
        created_at: user.created_at,
        xp: levelInfo.xp,
        level: levelInfo.level,
        xp_into_level: levelInfo.xpIntoLevel,
        xp_for_next_level: levelInfo.xpForNextLevel,
    };
}

export function UserProfileOutDto(
    user: User,
    followersCount: number,
    followingCount: number,
    isFollowing: boolean,
    isFriend: boolean,
) {
    return {
        ...UserOutDto(user),
        followersCount,
        followingCount,
        isFollowing,
        isFriend,
    };
}

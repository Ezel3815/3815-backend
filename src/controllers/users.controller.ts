import {
    Body,
    Controller,
    Delete,
    Get,
    Header,
    Param,
    ParseIntPipe,
    Post,
    Put,
    Query,
} from "@nestjs/common";
import { User } from "@prisma/client";
import { DAuth } from "src/decorators/auth.decorator";
import { DRole } from "src/decorators/role.decorator";
import { DUser } from "src/decorators/user.decorator";
import { LoginDto } from "src/dtos/auth/login.dto";
import { RegisterDto } from "src/dtos/auth/register.dto";
import { CreateUserDto } from "src/dtos/users/create-user.dto";
import { UpdateMeDto } from "src/dtos/users/update-me.dto";
import { UpdatePasswordDto } from "src/dtos/users/update-password.dto";
import { UpdateUserDto } from "src/dtos/users/update-user.dto";
import { UpdateProfileDto } from "src/dtos/users/update-profile.dto";
import { UpdateFcmTokenDto } from "src/dtos/users/update-fcm-token.dto";
import { UpdateStudyYearDto } from "src/dtos/users/update-study-year.dto";
import { AuthService } from "src/services/auth.service";
import { UsersService } from "src/services/users.service";
import { ApiTags } from "@nestjs/swagger";
import { FindQueryDto } from "src/dtos/find-query.dto";

@ApiTags("Users")
@Controller("users")
export class UsersController {
    constructor(private service: UsersService) {}

    @DRole()
    @Post("")
    async create(@Body() createUserDto: CreateUserDto) {
        return await this.service.create(createUserDto);
    }

    @DRole()
    @Get("")
    async read(@Query() findQueryDto: FindQueryDto) {
        return await this.service.read(findQueryDto);
    }

    @DAuth()
    @Get("me")
    async readMe(@DUser() user: User) {
        return await this.service.readOne(user.id);
    }

    @DAuth()
    @Put("me/profile")
    async updateMyProfile(
        @DUser() user: User,
        @Body() updateProfileDto: UpdateProfileDto,
    ) {
        return await this.service.updateProfile(user.id, updateProfileDto);
    }

    @DAuth()
    @Put("me/fcm-token")
    async updateFcmToken(
        @DUser() user: User,
        @Body() dto: UpdateFcmTokenDto,
    ) {
        return await this.service.updateFcmToken(
            user.id,
            dto.token && dto.token.length > 0 ? dto.token : null,
        );
    }

    @DAuth()
    @Get(":id/profile")
    async getProfile(
        @DUser() user: User,
        @Param("id", ParseIntPipe) id: number,
    ) {
        return await this.service.getProfile(id, user.id);
    }

    @DAuth()
    @Get(":id/followers")
    async followers(
        @DUser() user: User,
        @Param("id", ParseIntPipe) id: number,
    ) {
        return await this.service.getFollowList("followers", id, user.id);
    }

    @DAuth()
    @Get(":id/following")
    async following(
        @DUser() user: User,
        @Param("id", ParseIntPipe) id: number,
    ) {
        return await this.service.getFollowList("following", id, user.id);
    }

    @DAuth()
    @Post(":id/follow")
    async follow(
        @DUser() user: User,
        @Param("id", ParseIntPipe) id: number,
    ) {
        return await this.service.follow(user.id, id);
    }

    @DAuth()
    @Post(":id/remind")
    async remind(
        @DUser() user: User,
        @Param("id", ParseIntPipe) id: number,
    ) {
        return await this.service.remind(user.id, id);
    }

    @DAuth()
    @Delete(":id/follow")
    async unfollow(
        @DUser() user: User,
        @Param("id", ParseIntPipe) id: number,
    ) {
        return await this.service.unfollow(user.id, id);
    }

    @DAuth()
    @Get("search")
    async search(@DUser() user: User, @Query("q") q: string) {
        return await this.service.searchUsers(q, user.id);
    }

    @DAuth()
    @Get("mossad")
    async mossad(@DUser() user: User) {
        return await this.service.getMossad(user.id);
    }

    @DAuth()
    @Get("me/study-year")
    async studyYear(@DUser() user: User) {
        return await this.service.getStudyYear(user.id);
    }

    @DAuth()
    @Put("me/study-year")
    async setStudyYear(@DUser() user: User, @Body() dto: UpdateStudyYearDto) {
        return await this.service.setStudyYear(user.id, dto.study_year);
    }

    @DAuth()
    @Get("leaderboard")
    async leaderboard(@DUser() user: User) {
        return await this.service.getFriendsLeaderboard(user.id);
    }

    @DAuth()
    @Get("me/missions")
    async missions(@DUser() user: User) {
        return await this.service.getDailyMissions(user.id);
    }

    @DAuth()
    @Get("me/activity-feed")
    async activityFeed(@DUser() user: User) {
        return await this.service.getFriendsActivityFeed(user.id);
    }

    @DAuth()
    @Get("by-username/:username")
    async idByUsername(@Param("username") username: string) {
        return await this.service.getUserIdByUsername(username);
    }

    @Header("Content-Type", "text/html; charset=utf-8")
    @Get("share/:username")
    async sharePage(@Param("username") username: string) {
        return await this.service.getPublicProfileHtml(username);
    }

    @DAuth()
    @Get("me/feed")
    async feed(@DUser() user: User) {
        return await this.service.getFeed(user.id);
    }

    @DAuth()
    @Post("feed/:eventId/celebrate")
    async celebrate(
        @DUser() user: User,
        @Param("eventId", ParseIntPipe) eventId: number,
    ) {
        return await this.service.toggleCelebrate(user.id, eventId);
    }

    @DAuth()
    @Get("feed/:eventId/comments")
    async feedComments(
        @DUser() user: User,
        @Param("eventId", ParseIntPipe) eventId: number,
    ) {
        return await this.service.getFeedComments(user.id, eventId);
    }

    @DAuth()
    @Post("feed/:eventId/comments")
    async addFeedComment(
        @DUser() user: User,
        @Param("eventId", ParseIntPipe) eventId: number,
        @Body("text") text: string,
    ) {
        return await this.service.addFeedComment(user.id, eventId, text);
    }

    @DAuth()
    @Get("me/quests/friends")
    async questFriends(@DUser() user: User) {
        return await this.service.getQuestFriends(user.id);
    }

    @DAuth()
    @Put("me/quests/partner")
    async setQuestPartner(
        @DUser() user: User,
        @Body("friend_id", ParseIntPipe) friendId: number,
    ) {
        return await this.service.setQuestPartner(user.id, friendId);
    }

    @DAuth()
    @Get("me/quests")
    async quests(@DUser() user: User) {
        return await this.service.getQuests(user.id);
    }

    @DAuth()
    @Post("me/quests/claim")
    async claimQuest(@DUser() user: User, @Body("id") id: string) {
        return await this.service.claimQuestChest(user.id, String(id ?? ""));
    }

    @DAuth()
    @Get("me/achievements")
    async achievements(@DUser() user: User) {
        return await this.service.getAchievements(user.id);
    }

    @DRole()
    @Get(":id")
    async readOne(@Param("id", ParseIntPipe) id: number) {
        return await this.service.readOne(id);
    }

    @DAuth()
    @Put("me")
    async updateMe(@DUser() user: User, @Body() updateMeDto: UpdateMeDto) {
        return await this.service.updateMe(user.id, updateMeDto);
    }

    @DRole()
    @Put(":id")
    async update(
        @Param("id", ParseIntPipe) id: number,
        @Body() updateUserDto: UpdateUserDto,
    ) {
        return await this.service.update(id, updateUserDto);
    }

    @DAuth()
    @Put("me/password")
    async updateMyPassword(
        @DUser() user: User,
        @Body() updatePasswordDto: UpdatePasswordDto,
    ) {
        return await this.service.updateMyPassword(user.id, updatePasswordDto);
    }

    @DAuth()
    @Delete("me")
    async deleteMe(@DUser() user: User) {
        return await this.service.delete(user.id);
    }

    @DRole()
    @Delete(":id")
    async delete(@Param("id", ParseIntPipe) id: number) {
        return await this.service.delete(id);
    }
}

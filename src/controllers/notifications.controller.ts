import { Body, Controller, Get, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { User } from "@prisma/client";
import { DAuth } from "../decorators/auth.decorator";
import { DUser } from "../decorators/user.decorator";
import { NotificationEventsDto } from "../dtos/notifications/notification-events.dto";
import { NotificationsService } from "../services/notifications.service";

@ApiTags("Notifications")
@Controller("users")
export class NotificationsController {
    constructor(private service: NotificationsService) {}

    @DAuth()
    @Get("me/notification-state")
    async state(@DUser() user: User) {
        return await this.service.getState(user.id);
    }

    @DAuth()
    @Post("me/notification-events")
    async events(@DUser() user: User, @Body() dto: NotificationEventsDto) {
        return await this.service.recordEvents(user.id, dto.events ?? []);
    }
}

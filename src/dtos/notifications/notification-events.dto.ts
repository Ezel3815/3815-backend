import { Type } from "class-transformer";
import {
    IsArray,
    IsBoolean,
    IsInt,
    IsOptional,
    IsString,
    ValidateNested,
} from "class-validator";

/** One notification lifecycle record, reported by the app. `client_id` is its stable id (upsert key). */
export class NotificationEventDto {
    @IsString()
    client_id: string;

    @IsString()
    notification_type: string;

    @IsString()
    notification_pool: string;

    @IsString()
    message: string;

    @IsString()
    sent_at: string;

    @IsOptional() @IsString() opened_at?: string;
    @IsOptional() @IsBoolean() app_opened_after_notification?: boolean;
    @IsOptional() @IsBoolean() studied_after_notification?: boolean;
    @IsOptional() @IsString() study_session_started_at?: string;
    @IsOptional() @IsInt() cards_completed_after_notification?: number;
    @IsOptional() @IsBoolean() notification_converted_to_study?: boolean;
    @IsOptional() @IsInt() challenge_id?: number;
    @IsOptional() @IsInt() friend_id?: number;
}

export class NotificationEventsDto {
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => NotificationEventDto)
    events: NotificationEventDto[];
}

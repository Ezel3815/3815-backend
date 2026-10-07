import { DeckType } from "@prisma/client";
import {
    IsBIC,
    IsBoolean,
    IsEnum,
    IsNumber,
    IsOptional,
    IsSemVer,
    IsString,
    MaxLength,
    MinLength,
    IsInt,
} from "class-validator";

export class UpdateDeckDto {
    @IsOptional()
    @IsString()
    @MaxLength(30)
    @MinLength(1)
    title: string;

    @IsOptional()
    @IsNumber()
    parent_id: number;

    @IsOptional()
    @IsInt()
    order: number;

    @IsOptional()
    @IsBoolean()
    public: boolean;

    @IsOptional()
    @IsBoolean()
    visible: boolean;

    @IsOptional()
    @IsEnum(DeckType)
    type: DeckType;
}

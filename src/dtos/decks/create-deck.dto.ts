import { DeckType } from "@prisma/client";
import {
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

export class CreateDeckDto {
    @IsString()
    @MaxLength(30)
    @MinLength(1)
    title: string;

    @IsOptional()
    @IsNumber()
    parent_id: number;

    @IsOptional()
    @IsEnum(DeckType)
    type: DeckType = DeckType.CARDS_DECK;

    @IsOptional()
    @IsInt()
    order: number;

    @IsOptional()
    @IsBoolean()
    public: boolean = false;

    @IsOptional()
    @IsBoolean()
    visible: boolean = true;
}

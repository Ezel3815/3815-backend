import {
    IsArray,
    IsInt,
    IsNotIn,
    IsNumber,
    IsOptional,
    IsString,
    MaxLength,
    Min,
    MinLength,
} from "class-validator";

export class UpdateCodeDto {
    @IsOptional()
    @IsString()
    @MinLength(6)
    @MaxLength(20)
    code: string;

    @IsArray()
    @IsNumber(undefined, { each: true })
    decks_ids: number[];

    // VIP code: how many different students may use it. Leave out for a normal single-use code.
    @IsOptional()
    @IsInt()
    @Min(1)
    max_uses?: number;
}

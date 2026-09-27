import { ArrayMaxSize, IsArray, IsInt, IsString, MaxLength } from "class-validator";

export class UpdateTimezoneDto {
    @IsString()
    @MaxLength(64)
    timezone: string;
}

export class RevealPiecesDto {
    @IsArray()
    @ArrayMaxSize(100)
    @IsInt({ each: true })
    pieceIds: number[];
}

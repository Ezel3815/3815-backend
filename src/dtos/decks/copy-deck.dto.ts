import { IsInt, IsOptional } from "class-validator";

export class CopyDeckDto {
    // Decks Package to copy into. Empty = top level.
    @IsOptional()
    @IsInt()
    parent_id?: number | null;
}

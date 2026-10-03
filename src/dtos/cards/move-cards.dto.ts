import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt } from "class-validator";

export class MoveCardsDto {
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(500)
    @IsInt({ each: true })
    card_ids: number[];

    @IsInt()
    target_deck_id: number;
}

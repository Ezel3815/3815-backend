import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    ParseIntPipe,
    Post,
    Put,
    Query,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { User } from "@prisma/client";
import { DAuth } from "src/decorators/auth.decorator";
import { DRole } from "src/decorators/role.decorator";
import { DUser } from "src/decorators/user.decorator";
import { AnswerCardDto } from "src/dtos/cards/answer-card.dto";
import { ChangeCardsOrderDto } from "src/dtos/cards/change-cards-order.dto";
import { CreateCardDto } from "src/dtos/cards/create-card.dto";
import { UpdateCardDto } from "src/dtos/cards/update-card.dto";
import { FindQueryDto } from "src/dtos/find-query.dto";
import { DecksCardsService } from "src/services/decks-cards.service";
import { BulkUpdateAnswersDto } from "src/dtos/cards/bulk-update-answers.dto";
import { MoveCardsDto } from "src/dtos/cards/move-cards.dto";

@ApiTags("Cards")
@Controller("cards")
export class DecksCardsController {
    constructor(private service: DecksCardsService) {}

    @DAuth()
    @Put("answer/:cardId")
    async answerCard(
        @DUser() user: User,
        @Param("cardId", ParseIntPipe) cardId: number,
        @Body() answerCardDto: AnswerCardDto,
    ) {
        return await this.service.answer(user, cardId, answerCardDto);
    }

    @DAuth()
    @Put("bulk-answer")
    async buildAnswer(
        @DUser() user: User,
        @Body() bulkUpdateAnswersDto: BulkUpdateAnswersDto,
    ) {
        return await this.service.bulkAnswer(user, bulkUpdateAnswersDto);
    }

    // Admin only. Declared BEFORE ":deckId" so "move" is not read as a deck id.
    @DRole()
    @Post("move")
    async move(@DUser() user: User, @Body() moveCardsDto: MoveCardsDto) {
        return await this.service.move(user, moveCardsDto);
    }

    @DAuth()
    @Post(":deckId")
    async create(
        @DUser() user: User,
        @Param("deckId", ParseIntPipe) deckId: number,
        @Body() createCodeDto: CreateCardDto,
    ) {
        return await this.service.create(user, deckId, createCodeDto);
    }

    @DAuth()
    @Get(":deckId")
    async read(
        @DUser() user: User,
        @Param("deckId", ParseIntPipe) deckId: number,
    ) {
        return await this.service.read(user, deckId);
    }

    @DAuth()
    @Put(":deckId/:id")
    async update(
        @DUser() user: User,
        @Param("id", ParseIntPipe) id: number,
        @Param("deckId", ParseIntPipe) deckId: number,
        @Body() updateCodeDto: UpdateCardDto,
    ) {
        return await this.service.update(user, deckId, id, updateCodeDto);
    }

    @DAuth()
    @Delete(":deckId/:id")
    async delete(
        @DUser() user: User,
        @Param("deckId", ParseIntPipe) deckId: number,
        @Param("id", ParseIntPipe) id: number,
    ) {
        return await this.service.delete(user, deckId, id);
    }

    @DAuth()
    @Post("change-order/:deckId")
    async changeCardsOrder(
        @DUser() user: User,
        @Param("deckId", ParseIntPipe) deckId: number,
        @Body() changeCardsOrderDto: ChangeCardsOrderDto,
    ) {
        return await this.service.changeCardsOrder(
            user,
            deckId,
            changeCardsOrderDto,
        );
    }
}

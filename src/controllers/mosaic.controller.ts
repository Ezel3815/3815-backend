import { Body, Controller, Get, Post, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { User } from "@prisma/client";
import { DAuth } from "../decorators/auth.decorator";
import { DUser } from "../decorators/user.decorator";
import { RevealPiecesDto, UpdateTimezoneDto } from "../dtos/mosaic/mosaic.dto";
import { MosaicService } from "../mosaic/mosaic.service";

@ApiTags("Mosaic")
@Controller("users")
export class MosaicController {
    constructor(private service: MosaicService) {}

    /** Read-only: never awards anything, so refreshing/reopening is always safe. */
    @DAuth()
    @Get("me/mosaic")
    async state(@DUser() user: User) {
        return await this.service.getState(user.id);
    }

    /** Acknowledges that the client has played the reveal animation for these pieces. */
    @DAuth()
    @Post("me/mosaic/reveal")
    async reveal(@DUser() user: User, @Body() dto: RevealPiecesDto) {
        return await this.service.revealPieces(user.id, dto.pieceIds);
    }

    @DAuth()
    @Put("me/timezone")
    async timezone(@DUser() user: User, @Body() dto: UpdateTimezoneDto) {
        return await this.service.setTimezone(user.id, dto.timezone);
    }
}

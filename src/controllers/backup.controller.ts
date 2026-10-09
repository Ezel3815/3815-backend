import { Body, Controller, Get, Post, Query, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import { DRole } from "../decorators/role.decorator";
import { BackupService } from "../services/backup.service";

/** Admin-only backup / restore of decks + cards. */
@ApiTags("Backup")
@Controller("backup")
export class BackupController {
    constructor(private service: BackupService) {}

    @DRole()
    @Get("cards")
    async exportCards(
        @Query("all") all: string,
        @Res({ passthrough: true }) res: Response,
    ) {
        const day = new Date().toISOString().slice(0, 10);
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="mozaik-cards-${day}.json"`,
        );
        return await this.service.exportCards(all === "1" || all === "true");
    }

    @DRole()
    @Post("cards/restore")
    async restoreCards(@Body() body: any, @Query("overwrite") overwrite: string) {
        return await this.service.restoreCards(body, overwrite === "1" || overwrite === "true");
    }
}

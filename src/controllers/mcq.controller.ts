import { Controller, Get, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { DAuth } from "src/decorators/auth.decorator";
import { McqService } from "src/mcq/mcq.service";

/** Student-facing, read-only MCQ API. */
@ApiTags("MCQ")
@Controller("mcq")
export class McqController {
    constructor(private readonly mcq: McqService) {}

    /**
     * The whole published question bank in one response:
     * { subjects, collections, questions } - exactly what the app's
     * McqCatalog.build() consumes. Supports If-None-Match (304) so the app
     * only re-downloads when content actually changed.
     */
    @DAuth()
    @Get("catalog")
    async catalog(
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ) {
        const { etag, body } = await this.mcq.catalog();
        res.setHeader("ETag", etag);
        res.setHeader("Cache-Control", "private, no-cache");
        if (req.headers["if-none-match"] === etag) {
            res.status(304);
            return;
        }
        return body;
    }
}

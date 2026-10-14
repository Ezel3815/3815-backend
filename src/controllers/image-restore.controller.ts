import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    MaxFileSizeValidator,
    NotFoundException,
    Param,
    ParseFilePipe,
    ParseIntPipe,
    Post,
    Query,
    UploadedFile,
    UseInterceptors,
} from "@nestjs/common";
import { existsSync } from "fs";
import { join } from "path";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiTags } from "@nestjs/swagger";
import { CardType, MediaType, Prisma } from "@prisma/client";
import { PrismaService } from "nestjs-prisma";
import { DRole } from "src/decorators/role.decorator";
import { MediaService } from "src/services/media.service";

// Admin-only helpers for the dashboard "Restore images" page.
// GET  /image-restore            -> cards that need a picture (50 per page)
// POST /image-restore/:cardId    -> upload a picture + attach it to ONE side
//                                   of the card (never touches card.data).
@ApiTags("Image restore")
@Controller("image-restore")
export class ImageRestoreController {
    constructor(
        private prisma: PrismaService,
        private media: MediaService,
    ) {}

    // mode=broken  -> card has an image name that is NOT a web link
    //                 (= picture from the old, shut-down server)
    // mode=missing -> card has no picture at all (front AND back empty)
    // Optional: deck_id, after (last card id of previous page), limit (max 100)
    // Selecting a subject or chapter in the dropdown should include every
    // card in the decks nested under it, not just cards on that exact deck.
    private async deckAndDescendantIds(rootId: number): Promise<number[]> {
        const ids = [rootId];
        let frontier = [rootId];
        while (frontier.length) {
            const kids = await this.prisma.deck.findMany({
                where: { parent_id: { in: frontier } },
                select: { id: true },
            });
            frontier = kids.map((k) => k.id);
            ids.push(...frontier);
        }
        return ids;
    }

    // ---- Remove lost pictures (cards are kept, only the dead picture link goes) ----
    // GET    /image-restore/lost?deck_id=5  -> preview: how many cards/pictures
    // DELETE /image-restore/lost?deck_id=5  -> clears them
    // "Lost" = picture name is not a web link AND the file is not on this server.
    // Occlusion cards are never touched (their pictures hold the masks).
    private fileExists(name: string) {
        return [
            join(process.cwd(), "public", name),
            join(__dirname, "..", "..", "..", "public", name),
        ].some((p) => existsSync(p));
    }

    private async findLost(deckId?: string) {
        const and: Prisma.CardWhereInput[] = [
            { type: { not: CardType.OCCLUSION } },
            {
                OR: [
                    { front_image_name: { not: null } },
                    { back_image_name: { not: null } },
                ],
            },
        ];
        if (deckId) {
            const ids = await this.deckAndDescendantIds(Number(deckId));
            and.push({ deck_id: { in: ids } });
        }
        const cards = await this.prisma.card.findMany({
            where: { AND: and },
            select: { id: true, front_image_name: true, back_image_name: true },
        });
        const lost = (n: string | null) =>
            !!n && !n.startsWith("http") && !this.fileExists(n);
        const front: { id: number; name: string }[] = [];
        const back: { id: number; name: string }[] = [];
        for (const c of cards) {
            if (lost(c.front_image_name))
                front.push({ id: c.id, name: c.front_image_name! });
            if (lost(c.back_image_name))
                back.push({ id: c.id, name: c.back_image_name! });
        }
        return { front, back };
    }

    @DRole()
    @Get("lost")
    async lostPreview(@Query("deck_id") deckId?: string) {
        const { front, back } = await this.findLost(deckId);
        return {
            cards: new Set([...front, ...back].map((x) => x.id)).size,
            pictures: front.length + back.length,
        };
    }

    @DRole()
    @Delete("lost")
    async clearLost(@Query("deck_id") deckId?: string) {
        const { front, back } = await this.findLost(deckId);
        if (front.length)
            await this.prisma.card.updateMany({
                where: { id: { in: front.map((x) => x.id) } },
                data: { front_image_name: null },
            });
        if (back.length)
            await this.prisma.card.updateMany({
                where: { id: { in: back.map((x) => x.id) } },
                data: { back_image_name: null },
            });
        // Remove the now-orphaned Media rows (sequential: tiny DB pool).
        for (const x of [...front, ...back]) await this.media.delete(x.name);
        return {
            cards: new Set([...front, ...back].map((x) => x.id)).size,
            pictures: front.length + back.length,
        };
    }

    @DRole()
    @Get()
    async list(
        @Query("mode") mode: string = "broken",
        @Query("deck_id") deckId?: string,
        @Query("after") after?: string,
        @Query("limit") limit?: string,
    ) {
        const take = Math.min(Number(limit) || 50, 100);
        const isLink = { startsWith: "http" };

        const and: Prisma.CardWhereInput[] = [
            { type: { not: CardType.OCCLUSION } },
        ];
        if (deckId) {
            const ids = await this.deckAndDescendantIds(Number(deckId));
            and.push({ deck_id: { in: ids } });
        }

        if (mode === "missing") {
            and.push({ front_image_name: null, back_image_name: null });
        } else {
            and.push({
                OR: [
                    {
                        AND: [
                            { front_image_name: { not: null } },
                            { NOT: { front_image_name: isLink } },
                        ],
                    },
                    {
                        AND: [
                            { back_image_name: { not: null } },
                            { NOT: { back_image_name: isLink } },
                        ],
                    },
                ],
            });
        }
        const where: Prisma.CardWhereInput = { AND: and };
        // Match the order cards actually appear in the app: its own "order"
        // field within a deck, not DB creation id (only meaningful once a
        // single deck is picked - across mixed decks id order is kept).
        const byOrder = !!deckId;
        const cursorField = byOrder ? "order" : "id";

        // Sequential on purpose: the free DB has a tiny connection pool.
        const total = await this.prisma.card.count({ where });
        const cards = await this.prisma.card.findMany({
            where: after
                ? { AND: [...and, { [cursorField]: { gt: Number(after) } }] }
                : where,
            orderBy: byOrder ? { order: "asc" } : { id: "asc" },
            take,
            include: { deck: { select: { title: true } } },
        });

        return {
            total,
            next_after: cards.length
                ? cards[cards.length - 1][byOrder ? "order" : "id"]
                : null,
            cards: cards.map((c) => {
                let data: any = c.data;
                if (typeof data === "string") {
                    try {
                        data = JSON.parse(data);
                    } catch {}
                }
                const frontBroken =
                    !!c.front_image_name && !c.front_image_name.startsWith("http");
                return {
                    id: c.id,
                    deck_id: c.deck_id,
                    deck_title: c.deck?.title,
                    type: c.type,
                    // which side held the old picture (null in "missing" mode)
                    side:
                        mode === "missing" ? null : frontBroken ? "front" : "back",
                    data,
                };
            }),
        };
    }

    @DRole()
    @UseInterceptors(FileInterceptor("file"))
    @ApiConsumes("multipart/form-data")
    @Post(":cardId")
    async attach(
        @Param("cardId", ParseIntPipe) cardId: number,
        @Body("side") side: string,
        @UploadedFile(
            new ParseFilePipe({
                validators: [
                    new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }),
                ],
            }),
        )
        file: Express.Multer.File,
    ) {
        if (side !== "front" && side !== "back")
            throw new BadRequestException("side must be 'front' or 'back'");

        const card = await this.prisma.card.findUnique({
            where: { id: cardId },
        });
        if (!card) throw new NotFoundException("Card not found");
        if (card.type === CardType.OCCLUSION)
            throw new BadRequestException(
                "Occlusion cards need their masks redrawn; not supported here",
            );

        const oldName =
            side === "front" ? card.front_image_name : card.back_image_name;

        const media = await this.media.create(file, MediaType.IMAGE);
        await this.prisma.card.update({
            where: { id: cardId },
            data:
                side === "front"
                    ? { front_image_name: media.name }
                    : { back_image_name: media.name },
        });
        // Drop the dead reference (safe: errors are swallowed inside delete()).
        if (oldName) await this.media.delete(oldName);

        return { id: cardId, side, url: media.name };
    }
}

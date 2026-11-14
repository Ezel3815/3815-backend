import { Injectable, Logger } from "@nestjs/common";
import { MediaType, User, Prisma } from "@prisma/client";
import { PrismaService } from "nestjs-prisma";
import { ModelFileNames } from "src/utils/model.utils";
import { DocumentOutDto } from "src/dtos/decks/document.out-dto";
import {
    DeleteFile,
    GetRandomNameForFile,
    SaveFile,
} from "src/utils/files.utils";
@Injectable()
export class MediaService {
    private readonly logger = new Logger(MediaService.name);
    constructor(private prismaService: PrismaService) {}
    async create(file: Express.Multer.File, type: MediaType) {
        const originalName = GetRandomNameForFile(file);
        const url = await SaveFile(originalName, file.buffer);
        return await this.prismaService.media.create({
            data: { name: url, type },
        });
    }
    // FIX: deleting a card used to crash the whole request whenever one of
    // its images was already gone — either the Media row was missing (a
    // stale/orphaned front_image_name/back_image_name left over from the
    // old host migration) or the Cloudinary call failed (e.g. missing/bad
    // credentials). Either error used to bubble straight up as an
    // unhandled 500 ("Something went wrong"), and the card never got
    // deleted. Now each failure is logged and swallowed here, so a broken
    // image reference never blocks deleting the card itself.
    async delete(name: string) {
        try {
            await DeleteFile(name);
        } catch (err) {
            this.logger.warn(
                `Could not delete remote file "${name}" (continuing): ${err?.message ?? err}`,
            );
        }
        try {
            return await this.prismaService.media.delete({ where: { name } });
        } catch (err) {
            if (
                err instanceof Prisma.PrismaClientKnownRequestError &&
                err.code === "P2025"
            ) {
                // Row already gone (orphaned reference) — nothing to do.
                this.logger.warn(
                    `Media row "${name}" was already missing — skipping.`,
                );
                return null;
            }
            throw err;
        }
    }
    async deleteAllUnlinked() {
        const expiredDate = new Date();
        expiredDate.setHours(expiredDate.getHours() - 1);
        const media = await this.prismaService.media.findMany({
            where: {
                created_at: { lte: expiredDate },
                back_card: null,
                front_card: null,
                document_card: null,
            },
        });
        // 3D models are referenced only from inside card.data (no FK): keep the ones in use
        const used = new Set<string>();
        if (media.length) {
            const cards = await this.prismaService.$queryRaw<{ data: any }[]>`
                SELECT data FROM Card WHERE CAST(data AS CHAR) LIKE '%model%'`;
            for (const c of cards)
                for (const n of ModelFileNames(c.data)) used.add(n);
            const lib = await this.prismaService.$queryRaw<{ file_name: string }[]>`SELECT file_name FROM Model3D`;
            for (const m of lib) used.add(m.file_name);
        }
        const orphans = media.filter((m) => !used.has(m.name));
        for (const m of orphans) {
            await DeleteFile(m.name);
        }
        await this.prismaService.media.deleteMany({
            where: { name: { in: orphans.map((m) => m.name) } },
        });
    }
    /** Several cards can share one 3D model file: delete it only when no other card uses it. */
    async deleteModelIfUnused(name: string, exceptCardId: number) {
        const like = `%${name.replace(/[\\%_]/g, "\\$&")}%`;
        const other = await this.prismaService.$queryRaw<{ id: number }[]>`
            SELECT id FROM Card WHERE id <> ${exceptCardId}
            AND CAST(data AS CHAR) LIKE ${like} LIMIT 1`;
        if (other.length === 0) await this.delete(name);
    }

    async deleteForCard(cardId: number) {
        const card = await this.prismaService.card.findUnique({
            where: { id: cardId },
        });
        // Card already gone (e.g. deleted concurrently) — nothing to clean up.
        if (!card) return;

        // Dedupe in case front/back/document accidentally point at the same
        // media name — deleting the same row twice would otherwise throw.
        const names = new Set(
            [card.back_image_name, card.front_image_name, card.document_name]
                .filter(Boolean),
        );
        for (const name of names) {
            await this.delete(name);
        }
        for (const name of ModelFileNames(card.data)) {
            await this.deleteModelIfUnused(name, cardId);
        }
    }
    async readDocuments(user: User) {
        const documents = await this.prismaService.media.findMany({
            where: {
                type: MediaType.PDF,
                document_card: {
                    deck: {
                        OR: [
                            {
                                users: {
                                    some: {
                                        user_id: user.id,
                                    },
                                },
                            },
                            {
                                public: true,
                            },
                        ],
                    },
                },
            },
            include: {
                document_card: true,
            },
        });
        return documents.map((deck) => DocumentOutDto(deck));
    }
}

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { MediaType } from "@prisma/client";
import { PrismaService } from "nestjs-prisma";
import { GetFileUrl } from "src/utils/files.utils";
import { MediaService } from "src/services/media.service";

const clean = (v: any, max: number) => String(v ?? "").trim().slice(0, max);

/** The library of ready 3D models (.glb). The pipeline AI picks from it; the dashboard lists it. */
@Injectable()
export class Models3dService {
    constructor(private prisma: PrismaService, private media: MediaService) {}

    private out(m: { id: number; name: string; aliases: string | null; category: string | null; file_name: string; created_at: Date }) {
        return { id: m.id, name: m.name, aliases: m.aliases ?? "", category: m.category ?? "", file_name: m.file_name, url: GetFileUrl(m.file_name), created_at: m.created_at };
    }

    async list() {
        const rows = await this.prisma.model3D.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] });
        return rows.map((m) => this.out(m));
    }

    async create(file: Express.Multer.File, body: { name?: string; aliases?: string; category?: string }) {
        if (!file || !/\.(glb)$/i.test(file.originalname)) throw new BadRequestException("Upload a .glb file (a single-file 3D model).");
        const name = clean(body.name, 190) || file.originalname.replace(/\.glb$/i, "").replace(/[_-]+/g, " ").trim();
        if (!name) throw new BadRequestException("The model needs a name.");
        const media = await this.media.create(file, MediaType.MODEL);
        try {
            const m = await this.prisma.model3D.create({
                data: { name, aliases: clean(body.aliases, 2000) || null, category: clean(body.category, 100) || null, file_name: media.name },
            });
            return this.out(m);
        } catch (e) {
            await this.media.delete(media.name); // do not leave an unused file behind
            throw e;
        }
    }

    async update(id: number, body: { name?: string; aliases?: string; category?: string }) {
        const name = clean(body.name, 190);
        if (!name) throw new BadRequestException("The model needs a name.");
        try {
            const m = await this.prisma.model3D.update({
                where: { id },
                data: { name, aliases: clean(body.aliases, 2000) || null, category: clean(body.category, 100) || null },
            });
            return this.out(m);
        } catch {
            throw new NotFoundException("Model not found");
        }
    }

    async remove(id: number) {
        const m = await this.prisma.model3D.findUnique({ where: { id } });
        if (!m) throw new NotFoundException("Model not found");
        await this.prisma.model3D.delete({ where: { id } });
        // cards may still use this file: it is removed only when none does
        await this.media.deleteModelIfUnused(m.file_name, 0);
        return { ok: true };
    }
}

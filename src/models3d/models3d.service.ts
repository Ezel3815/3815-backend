import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { MediaType } from "@prisma/client";
import { PrismaService } from "nestjs-prisma";
import { GetFileUrl } from "src/utils/files.utils";
import { mergeGlbs } from "src/utils/glb-merge";
import { MediaService } from "src/services/media.service";

const clean = (v: any, max: number) => String(v ?? "").trim().slice(0, max);
/** Library rows made by combine() (a muscle + its bones in one file). They are not offered to the AI again. */
export const COMBINED = "Combined";
const MAX_BONES = 5;

/** The library of ready 3D models (.glb). The pipeline AI picks from it; the dashboard lists it. */
@Injectable()
export class Models3dService {
    constructor(private prisma: PrismaService, private media: MediaService) {}

    private out(m: { id: number; name: string; aliases: string | null; category: string | null; file_name: string; created_at: Date }) {
        return { id: m.id, name: m.name, aliases: m.aliases ?? "", category: m.category ?? "", file_name: m.file_name, url: GetFileUrl(m.file_name), created_at: m.created_at };
    }

    /** Several combinations can be built at once: the same one is built only once. */
    private building = new Map<string, Promise<ReturnType<Models3dService["out"]>>>();

    private async download(name: string): Promise<Buffer> {
        const res = await fetch(GetFileUrl(name));
        if (!res.ok) throw new Error(`could not read a model file (${res.status})`);
        return Buffer.from(await res.arrayBuffer());
    }

    /**
     * One model made of a library model (the muscle) plus the bones around it, saved as a new library row
     * (category "Combined") so the same combination is reused. The parts keep their own positions, so they
     * must come from the same body (they do when taken from one anatomy set).
     */
    async combine(modelId: number, boneIds: number[]) {
        const bones = [...new Set((boneIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== modelId))].sort((a, b) => a - b).slice(0, MAX_BONES);
        const key = `combo:${[modelId, ...bones].join("+")}`;
        const running = this.building.get(key);
        if (running) return running;
        const job = this.buildCombined(modelId, bones, key).finally(() => this.building.delete(key));
        this.building.set(key, job);
        return job;
    }

    private async buildCombined(modelId: number, bones: number[], key: string) {
        const rows = await this.prisma.model3D.findMany({ where: { id: { in: [modelId, ...bones] } } });
        const main = rows.find((r) => r.id === modelId);
        if (!main) throw new NotFoundException("Model not found");
        const parts = [main, ...bones.map((id) => rows.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r && r.category !== COMBINED)];
        if (parts.length < 2) return this.out(main); // no bone to add: the model alone
        const known = await this.prisma.model3D.findFirst({ where: { category: COMBINED, aliases: key } });
        if (known) return this.out(known);
        const files = await Promise.all(parts.map(async (p) => ({ name: p.name, data: await this.download(p.file_name) })));
        let merged: Buffer;
        try { merged = mergeGlbs(files); } catch (e: any) { throw new BadRequestException(`Could not combine the models: ${e?.message ?? e}`); }
        const media = await this.media.create({ originalname: "combined.glb", buffer: merged, size: merged.length, mimetype: "model/gltf-binary" } as Express.Multer.File, MediaType.MODEL);
        try {
            const m = await this.prisma.model3D.create({
                data: { name: parts.map((p) => p.name).join(" + ").slice(0, 190), aliases: key, category: COMBINED, file_name: media.name },
            });
            return this.out(m);
        } catch (e) {
            await this.media.delete(media.name);
            throw e;
        }
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

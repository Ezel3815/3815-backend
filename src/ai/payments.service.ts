import { Injectable } from "@nestjs/common";
import { PrismaService } from "nestjs-prisma";
import { randomBytes } from "crypto";
import { GenerateBadRequestException } from "src/exception/bad-request.exception";
import { AiService } from "./ai.service";

// Prices / payment destination come from env so you can change them without a deploy of code.
const PRICE = { MONTHLY: Number(process.env.AI_PRICE_MONTHLY_USD ?? 5.99), YEARLY: Number(process.env.AI_PRICE_YEARLY_USD ?? 49.99) };

@Injectable()
export class PaymentsService {
    constructor(private prisma: PrismaService, private ai: AiService) {}

    plans() {
        return {
            monthly: { plan: "MONTHLY", price_usd: PRICE.MONTHLY },
            yearly: { plan: "YEARLY", price_usd: PRICE.YEARLY, saving_percent: Math.round((1 - PRICE.YEARLY / (PRICE.MONTHLY * 12)) * 100) },
            methods: [{
                method: "SHAM_CASH", wallet: process.env.SHAM_CASH_WALLET ?? "", account_name: process.env.SHAM_CASH_NAME ?? "", qr_url: process.env.SHAM_CASH_QR_URL ?? "",
            }],
        };
    }

    /** Step 1: the user picks a plan. Returns how much to send and the reference code to write in the transfer note. */
    async start(userId: number, plan: string) {
        if (plan !== "MONTHLY" && plan !== "YEARLY") GenerateBadRequestException(["plan must be MONTHLY or YEARLY."]);
        const open = await this.prisma.aiPayment.count({ where: { user_id: userId, status: { in: ["PENDING", "SUBMITTED"] } } });
        if (open >= 3) GenerateBadRequestException(["You already have open payment requests. Finish or wait for review."]);
        const p = await this.prisma.aiPayment.create({
            data: { user_id: userId, plan, amount_usd: PRICE[plan as "MONTHLY" | "YEARLY"], reference: "AI-" + randomBytes(3).toString("hex").toUpperCase() },
        });
        return { ...this.view(p), ...this.plans().methods[0] };
    }

    /** Step 2: after paying in Sham Cash the user sends the transaction number (+ optional screenshot). */
    async submit(userId: number, id: number, txId: string, file?: Express.Multer.File) {
        const p = await this.prisma.aiPayment.findFirst({ where: { id, user_id: userId } });
        if (!p) GenerateBadRequestException(["Payment request not found."], "Not Found", 404);
        if (p!.status !== "PENDING") GenerateBadRequestException(["This request was already submitted."]);
        const tx = String(txId ?? "").trim();
        if (tx.length < 4 || tx.length > 100) GenerateBadRequestException(["Enter the Sham Cash transaction number."]);
        if (await this.prisma.aiPayment.findUnique({ where: { tx_id: tx } })) GenerateBadRequestException(["This transaction number was already used."]);
        const u = await this.prisma.aiPayment.update({
            where: { id }, data: { tx_id: tx, status: "SUBMITTED", ...(file ? { proof: file.buffer, proof_mime: file.mimetype } : {}) },
        });
        return this.view(u);
    }

    mine(userId: number) {
        return this.prisma.aiPayment.findMany({ where: { user_id: userId }, orderBy: { created_at: "desc" }, take: 20 }).then((r) => r.map((p) => this.view(p)));
    }

    // ---- admin ----
    pending() {
        return this.prisma.aiPayment.findMany({
            where: { status: "SUBMITTED" }, orderBy: { created_at: "asc" },
            include: { user: { select: { id: true, name: true, email: true } } },
        }).then((r) => r.map(({ proof, ...p }) => ({ ...p, has_proof: !!proof })));
    }
    async proof(id: number) {
        const p = await this.prisma.aiPayment.findUnique({ where: { id }, select: { proof: true, proof_mime: true } });
        if (!p?.proof) GenerateBadRequestException(["No screenshot."], "Not Found", 404);
        return { buffer: Buffer.from(p!.proof!), mime: p!.proof_mime || "image/jpeg" };
    }
    async approve(id: number) {
        const p = await this.prisma.aiPayment.findUnique({ where: { id } });
        if (!p || p.status !== "SUBMITTED") GenerateBadRequestException(["Only submitted payments can be approved."]);
        await this.prisma.aiPayment.update({ where: { id }, data: { status: "APPROVED", reviewed_at: new Date() } });
        return this.ai.grant(p!.user_id, p!.plan as any, "sham_cash", p!.reference);
    }
    async reject(id: number, note?: string) {
        const p = await this.prisma.aiPayment.findUnique({ where: { id } });
        if (!p || p.status !== "SUBMITTED") GenerateBadRequestException(["Only submitted payments can be rejected."]);
        const u = await this.prisma.aiPayment.update({ where: { id }, data: { status: "REJECTED", note: note?.slice(0, 300), reviewed_at: new Date() } });
        return this.view(u);
    }

    private view(p: any) {
        return { id: p.id, plan: p.plan, amount_usd: Number(p.amount_usd), method: p.method, reference: p.reference, status: p.status, tx_id: p.tx_id, note: p.note, created_at: p.created_at };
    }
}

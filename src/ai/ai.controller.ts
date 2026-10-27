import { Body, Controller, Patch, Query, Res, Delete, Get, MaxFileSizeValidator, Param, ParseFilePipe, ParseIntPipe, Post, UploadedFiles, UseInterceptors, FileTypeValidator } from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiTags } from "@nestjs/swagger";
import { User } from "@prisma/client";
import { DAuth } from "src/decorators/auth.decorator";
import { DRole } from "src/decorators/role.decorator";
import { DUser } from "src/decorators/user.decorator";
import { GenerateBadRequestException } from "src/exception/bad-request.exception";
import { AiService } from "./ai.service";
import { QuizService } from "./quiz.service";
import { PaymentsService } from "./payments.service";

@ApiTags("AI")
@Controller("ai")
export class AiController {
    constructor(private s: AiService, private quiz: QuizService, private pay: PaymentsService) {}

    /** Quota state for the app: remaining tries, next_available_at (free), or plan/expiry (premium). */
    @DAuth() @Get("status")
    status(@DUser() user: User) { return this.s.status(user.id); }

    /**
     * multipart/form-data: images (1-3 files), mode=flashcards|mcq, count (1-20, default 10),
     * language?, instructions?, deck_id? (if set, results are also saved into that deck).
     */
    @DAuth()
    @UseInterceptors(FilesInterceptor("images", 3))
    @ApiConsumes("multipart/form-data")
    @Post("scan")
    scan(
        @DUser() user: User,
        @UploadedFiles(new ParseFilePipe({ validators: [new MaxFileSizeValidator({ maxSize: 8 * 1024 * 1024 }), new FileTypeValidator({ fileType: /^image\/(jpeg|png|webp|heic|heif)$/ })] })) files: Express.Multer.File[],
        @Body() b: { mode?: string; count?: string; language?: string; instructions?: string; deck_id?: string; title?: string; deck_title?: string },
    ) {
        if (b.mode !== "flashcards" && b.mode !== "mcq") GenerateBadRequestException(["mode must be 'flashcards' or 'mcq'."]);
        const count = Math.min(20, Math.max(1, Math.floor(Number(b.count)) || 10));
        const deckId = b.deck_id ? Number(b.deck_id) : undefined;
        if (b.deck_id && !Number.isInteger(deckId)) GenerateBadRequestException(["Invalid deck_id."]);
        return this.s.scan(user, files, { mode: b.mode as any, count, language: b.language?.slice(0, 40), instructions: b.instructions, deckId, title: b.title?.slice(0, 150), deckTitle: b.deck_title?.slice(0, 60) });
    }

    // ---- admin: manual grant (until store billing is wired) ----
    @DRole() @Post("subscriptions/:userId")
    grant(@Param("userId", ParseIntPipe) userId: number, @Body() b: { plan: string }) {
        if (b.plan !== "MONTHLY" && b.plan !== "YEARLY") GenerateBadRequestException(["plan must be MONTHLY or YEARLY."]);
        return this.s.grant(userId, b.plan as any);
    }
    @DRole() @Delete("subscriptions/:userId")
    revoke(@Param("userId", ParseIntPipe) userId: number) { return this.s.revoke(userId); }

    // ---- "Keep" after reviewing a scan result ----
    @DAuth() @Post("flashcards/keep")
    keepCards(@DUser() u: User, @Body() b: { deck_id?: number; deck_title?: string; items: any[] }) {
        return this.s.keepFlashcards(u, { deckId: b.deck_id ? Number(b.deck_id) : undefined, deckTitle: b.deck_title?.slice(0, 60), items: b.items });
    }
    @DAuth() @Post("quizzes/keep")
    keepQuizItems(@DUser() u: User, @Body() b: { title?: string; items: any[] }) { return this.s.keepQuiz(u, { title: b.title?.slice(0, 150), items: b.items }); }

    // ---- MCQ quizzes ----
    @DAuth() @Get("quizzes") quizzes(@DUser() u: User) { return this.quiz.list(u.id); }
    @DAuth() @Get("quizzes/:id") quizGet(@DUser() u: User, @Param("id", ParseIntPipe) id: number) { return this.quiz.get(u.id, id); }
    @DAuth() @Patch("quizzes/:id") quizRename(@DUser() u: User, @Param("id", ParseIntPipe) id: number, @Body() b: { title: string }) { return this.quiz.rename(u.id, id, b.title); }
    @DAuth() @Delete("quizzes/:id") quizDelete(@DUser() u: User, @Param("id", ParseIntPipe) id: number) { return this.quiz.remove(u.id, id); }
    @DAuth() @Post("quizzes/:id/submit") quizSubmit(@DUser() u: User, @Param("id", ParseIntPipe) id: number, @Body() b: { answers: (number | null)[] }) { return this.quiz.submit(u.id, id, b.answers); }

    // ---- payments (Sham Cash, manual review) ----
    @DAuth() @Get("plans") plans() { return this.pay.plans(); }
    @DAuth() @Post("payments") payStart(@DUser() u: User, @Body() b: { plan: string }) { return this.pay.start(u.id, b.plan); }
    @DAuth() @Get("payments") payMine(@DUser() u: User) { return this.pay.mine(u.id); }
    @DAuth()
    @UseInterceptors(FilesInterceptor("proof", 1))
    @ApiConsumes("multipart/form-data")
    @Post("payments/:id/submit")
    paySubmit(
        @DUser() u: User, @Param("id", ParseIntPipe) id: number, @Body() b: { tx_id: string },
        @UploadedFiles(new ParseFilePipe({ fileIsRequired: false, validators: [new MaxFileSizeValidator({ maxSize: 4 * 1024 * 1024 }), new FileTypeValidator({ fileType: /^image\/(jpeg|png|webp)$/ })] })) files?: Express.Multer.File[],
    ) { return this.pay.submit(u.id, id, b.tx_id, files?.[0]); }

    @DRole() @Get("admin/payments") payPending() { return this.pay.pending(); }
    @DRole() @Get("admin/payments/:id/proof")
    async payProof(@Param("id", ParseIntPipe) id: number, @Res() res: any) { const p = await this.pay.proof(id); res.setHeader("Content-Type", p.mime); res.send(p.buffer); }
    @DRole() @Post("admin/payments/:id/approve") payApprove(@Param("id", ParseIntPipe) id: number) { return this.pay.approve(id); }
    @DRole() @Post("admin/payments/:id/reject") payReject(@Param("id", ParseIntPipe) id: number, @Body() b: { note?: string }) { return this.pay.reject(id, b?.note); }
}

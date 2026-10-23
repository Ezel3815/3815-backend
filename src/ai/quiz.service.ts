import { Injectable } from "@nestjs/common";
import { PrismaService } from "nestjs-prisma";
import { GenerateBadRequestException } from "src/exception/bad-request.exception";

export interface McqItem { question: string; options: string[]; correct: number; explanation?: string }

@Injectable()
export class QuizService {
    constructor(private prisma: PrismaService) {}

    async create(userId: number, title: string, items: McqItem[]) {
        const quiz = await this.prisma.quiz.create({
            data: {
                user_id: userId, title: title.trim().slice(0, 150) || "Quiz",
                questions: { create: items.map((q, i) => ({ order: i + 1, question: q.question, options: q.options, correct: q.correct, explanation: q.explanation || null })) },
            },
            include: { questions: { orderBy: { order: "asc" } } },
        });
        return quiz;
    }

    list(userId: number) {
        return this.prisma.quiz.findMany({
            where: { user_id: userId }, orderBy: { created_at: "desc" },
            select: { id: true, title: true, created_at: true, _count: { select: { questions: true } }, attempts: { orderBy: { created_at: "desc" }, take: 1, select: { score: true, total: true, created_at: true } } },
        });
    }

    private async own(userId: number, id: number) {
        const q = await this.prisma.quiz.findFirst({ where: { id, user_id: userId }, include: { questions: { orderBy: { order: "asc" } } } });
        if (!q) GenerateBadRequestException(["Quiz not found."], "Not Found", 404);
        return q!;
    }
    get(userId: number, id: number) { return this.own(userId, id); }

    async rename(userId: number, id: number, title: string) {
        await this.own(userId, id);
        return this.prisma.quiz.update({ where: { id }, data: { title: String(title ?? "").trim().slice(0, 150) || "Quiz" } });
    }
    async remove(userId: number, id: number) {
        await this.own(userId, id);
        await this.prisma.quiz.delete({ where: { id } });
        return { ok: true };
    }

    /** answers[i] = chosen option index for question i (null = skipped). Score is computed on the server. */
    async submit(userId: number, id: number, answers: (number | null)[]) {
        const quiz = await this.own(userId, id);
        if (!Array.isArray(answers) || answers.length !== quiz.questions.length) GenerateBadRequestException([`Send exactly ${quiz.questions.length} answers.`]);
        const review = quiz.questions.map((q, i) => {
            const a = Number.isInteger(answers[i]) ? (answers[i] as number) : null;
            return { question_id: q.id, chosen: a, correct: q.correct, is_correct: a === q.correct, explanation: q.explanation };
        });
        const score = review.filter((r) => r.is_correct).length;
        const attempt = await this.prisma.quizAttempt.create({ data: { quiz_id: id, user_id: userId, score, total: review.length, answers: answers as any } });
        return { attempt_id: attempt.id, score, total: review.length, review };
    }
}

import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Post,
    Put,
    Query,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { DRole } from "src/decorators/role.decorator";
import { McqService } from "src/mcq/mcq.service";

const flag = (v?: string): boolean => v === "true" || v === "1";
const optFlag = (v?: string): boolean | undefined =>
    v === undefined || v === "" ? undefined : flag(v);
const optInt = (v?: string): number | undefined => {
    if (v === undefined || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
};

/**
 * Dashboard-facing MCQ management. Admin only (RoleGuard).
 * Request/response bodies use the same JSON shape as the import file and the
 * student catalog (see src/mcq/MCQ_API.md).
 */
@ApiTags("MCQ Admin")
@Controller("admin/mcq")
export class McqAdminController {
    constructor(private readonly mcq: McqService) {}

    // ---- subjects
    @DRole()
    @Get("subjects")
    listSubjects() {
        return this.mcq.listSubjects();
    }

    @DRole()
    @Post("subjects")
    createSubject(@Body() body: any) {
        return this.mcq.createSubject(body);
    }

    @DRole()
    @Put("subjects/:id")
    updateSubject(@Param("id") id: string, @Body() body: any) {
        return this.mcq.updateSubject(id, body);
    }

    @DRole()
    @Delete("subjects/:id")
    deleteSubject(@Param("id") id: string, @Query("force") force?: string) {
        return this.mcq.deleteSubject(id, flag(force));
    }

    // ---- collections
    @DRole()
    @Get("collections")
    listCollections(@Query("subject_id") subjectId?: string) {
        return this.mcq.listCollections(subjectId);
    }

    @DRole()
    @Post("collections")
    createCollection(@Body() body: any) {
        return this.mcq.createCollection(body);
    }

    @DRole()
    @Put("collections/:id")
    updateCollection(@Param("id") id: string, @Body() body: any) {
        return this.mcq.updateCollection(id, body);
    }

    @DRole()
    @Delete("collections/:id")
    deleteCollection(@Param("id") id: string, @Query("force") force?: string) {
        return this.mcq.deleteCollection(id, flag(force));
    }

    // ---- questions
    @DRole()
    @Get("questions")
    listQuestions(
        @Query("subject_id") subject_id?: string,
        @Query("collection_id") collection_id?: string,
        @Query("search") search?: string,
        @Query("published") published?: string,
        @Query("page") page?: string,
        @Query("limit") limit?: string,
    ) {
        return this.mcq.listQuestions({
            subject_id,
            collection_id,
            search,
            published: optFlag(published),
            page: optInt(page),
            limit: optInt(limit),
        });
    }

    @DRole()
    @Get("questions/:id")
    getQuestion(@Param("id") id: string) {
        return this.mcq.getQuestion(id);
    }

    @DRole()
    @Post("questions")
    createQuestion(@Body() body: any) {
        return this.mcq.createQuestion(body);
    }

    @DRole()
    @Put("questions/:id")
    updateQuestion(@Param("id") id: string, @Body() body: any) {
        return this.mcq.updateQuestion(id, body);
    }

    @DRole()
    @Delete("questions/:id")
    deleteQuestion(@Param("id") id: string) {
        return this.mcq.deleteQuestion(id);
    }

    // ---- bulk
    /** ?dry_run=true validates only; ?strict=true writes nothing if any record is invalid. */
    @DRole()
    @Post("import")
    importBank(
        @Body() body: any,
        @Query("dry_run") dryRun?: string,
        @Query("strict") strict?: string,
    ) {
        return this.mcq.importBank(body, { dryRun: flag(dryRun), strict: flag(strict) });
    }

    @DRole()
    @Get("export")
    exportBank(@Query("subject_id") subjectId?: string) {
        return this.mcq.exportBank(subjectId);
    }
}

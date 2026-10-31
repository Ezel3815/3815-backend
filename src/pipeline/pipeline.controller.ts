import { Body, Controller, Delete, Get, MaxFileSizeValidator, Param, ParseFilePipe, ParseIntPipe, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiTags } from "@nestjs/swagger";
import { User } from "@prisma/client";
import { DRole } from "src/decorators/role.decorator";
import { DUser } from "src/decorators/user.decorator";
import { PipelineService } from "./pipeline.service";

// Admin-only. Create cards -> polish -> pictures -> report, all on the server (works with the browser closed).
@ApiTags("Pipeline")
@Controller("pipeline")
export class PipelineController {
    constructor(private s: PipelineService) {}

    @DRole() @Get("keys") keys() { return this.s.keys(); }
    @DRole() @Post("keys") addKeys(@Body() b: { text: string; role: any }) { return this.s.addKeys(b.text, b.role); }
    @DRole() @Post("keys/revive") revive() { return this.s.reviveKeys(); }
    @DRole() @Delete("keys/:id") removeKey(@Param("id", ParseIntPipe) id: number) { return this.s.removeKey(id); }
    @DRole() @Get("jobs") list() { return this.s.list(); }
    @DRole() @Get("jobs/:id") detail(@Param("id", ParseIntPipe) id: number) { return this.s.detail(id); }
    @DRole() @Post("mcq-jobs") createMcq(@DUser() user: User, @Body() body: any) { return this.s.createMcq(user, body); }
    @DRole() @Post("jobs/:id/mcq-publish") mcqPublish(@Param("id", ParseIntPipe) id: number) { return this.s.mcqPublish(id); }
    @DRole() @Post("jobs") create(@DUser() user: User, @Body() body: any) { return this.s.create(user, body); }

    @DRole()
    @UseInterceptors(FileInterceptor("file"))
    @ApiConsumes("multipart/form-data")
    @Post("jobs/:id/files/:lectureId")
    file(
        @Param("id", ParseIntPipe) id: number,
        @Param("lectureId") lectureId: string,
        @UploadedFile(new ParseFilePipe({ validators: [new MaxFileSizeValidator({ maxSize: 18 * 1024 * 1024 })] })) file: Express.Multer.File,
    ) { return this.s.saveFile(id, lectureId, file); }

    @DRole() @Post("jobs/:id/start") start(@Param("id", ParseIntPipe) id: number, @Body() b: { runAt?: number }) { return this.s.start(id, b?.runAt ? Number(b.runAt) : undefined); }
    @DRole() @Post("jobs/:id/pause") pause(@Param("id", ParseIntPipe) id: number) { return this.s.pause(id); }
    @DRole() @Delete("jobs/:id") remove(@Param("id", ParseIntPipe) id: number) { return this.s.remove(id); }
}

import { Body, Controller, Delete, Get, MaxFileSizeValidator, Param, ParseFilePipe, ParseIntPipe, Post, Put, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiTags } from "@nestjs/swagger";
import { DRole } from "src/decorators/role.decorator";
import { Models3dService } from "./models3d.service";

// Admin-only library of 3D models. Dashboard: "3D models library". The AI pipeline reads the same table.
@ApiTags("Models3D")
@Controller("models3d")
export class Models3dController {
    constructor(private s: Models3dService) {}

    @DRole() @Get() list() { return this.s.list(); }

    @DRole()
    @UseInterceptors(FileInterceptor("file"))
    @ApiConsumes("multipart/form-data")
    @Post()
    create(
        @UploadedFile(new ParseFilePipe({ validators: [new MaxFileSizeValidator({ maxSize: 25 * 1024 * 1024 })] })) file: Express.Multer.File,
        @Body() body: { name?: string; aliases?: string; category?: string },
    ) {
        return this.s.create(file, body);
    }

    @DRole() @Put(":id") update(@Param("id", ParseIntPipe) id: number, @Body() body: any) { return this.s.update(id, body); }
    @DRole() @Delete(":id") remove(@Param("id", ParseIntPipe) id: number) { return this.s.remove(id); }
}

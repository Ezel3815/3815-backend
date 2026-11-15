import {
    Controller,
    FileTypeValidator,
    Get,
    MaxFileSizeValidator,
    ParseFilePipe,
    Post,
    UploadedFile,
    UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBody, ApiConsumes, ApiTags } from "@nestjs/swagger";
import { MediaType, User } from "@prisma/client";
import { DAuth } from "src/decorators/auth.decorator";
import { DRole } from "src/decorators/role.decorator";
import { DUser } from "src/decorators/user.decorator";
import { MediaService } from "src/services/media.service";
import { GenerateBadRequestException } from "src/exception/bad-request.exception";

@ApiTags("Media")
@Controller("media")
export class MediaController {
    constructor(private service: MediaService) {}

    // @DAuth()
    @UseInterceptors(FileInterceptor("file"))
    @ApiConsumes("multipart/form-data")
    @ApiBody({
        schema: {
            type: "object",
            properties: {
                file: {
                    type: "string",
                    format: "binary",
                },
            },
        },
    })
    @Post("image")
    async uploadImage(
        @UploadedFile(
            new ParseFilePipe({
                validators: [
                    new MaxFileSizeValidator({
                        maxSize: 1024 * 1024 * 10,
                        message: (maxSize: number) =>
                            `You can't upload file with size greater than ${maxSize / (1024 * 1024)}Mb`,
                    }),
                    // new FileTypeValidator({ fileType: "image" }),
                ],
            }),
        )
        file: Express.Multer.File,
    ) {
        return await this.service.create(file, MediaType.IMAGE);
    }

    // @DRole()
    @UseInterceptors(FileInterceptor("file"))
    @ApiConsumes("multipart/form-data")
    @ApiBody({
        schema: {
            type: "object",
            properties: {
                file: {
                    type: "string",
                    format: "binary",
                },
            },
        },
    })
    @Post("admin-image")
    async uploadImageByAdmin(
        @UploadedFile(
            new ParseFilePipe({
                validators: [
                    // new FileTypeValidator({ fileType: "image/jpeg" })
                ],
            }),
        )
        file: Express.Multer.File,
    ) {
        return await this.service.create(file, MediaType.IMAGE);
    }

    // @DRole()
    @UseInterceptors(FileInterceptor("file"))
    @ApiConsumes("multipart/form-data")
    @ApiBody({
        schema: {
            type: "object",
            properties: {
                file: {
                    type: "string",
                    format: "binary",
                },
            },
        },
    })
    @Post("document")
    async uploadDocument(
        @UploadedFile(
            new ParseFilePipe({
                validators: [
                    // new FileTypeValidator({ fileType: "pdf" })
                ],
            }),
        )
        file: Express.Multer.File,
    ) {
        return await this.service.create(file, MediaType.PDF);
    }

    // 3D model (.glb) for a card: stored as a raw file, admins only.
    @DRole()
    @UseInterceptors(FileInterceptor("file"))
    @ApiConsumes("multipart/form-data")
    @ApiBody({
        schema: { type: "object", properties: { file: { type: "string", format: "binary" } } },
    })
    @Post("model")
    async uploadModel(
        @UploadedFile(
            new ParseFilePipe({
                validators: [
                    new MaxFileSizeValidator({
                        maxSize: 1024 * 1024 * 25,
                        message: (maxSize: number) =>
                            `You can't upload a model larger than ${maxSize / (1024 * 1024)}Mb`,
                    }),
                ],
            }),
        )
        file: Express.Multer.File,
    ) {
        if (!/\.(glb|gltf)$/i.test(file.originalname))
            GenerateBadRequestException(["Upload a .glb file (a single-file 3D model)"]);
        return await this.service.create(file, MediaType.MODEL);
    }

    @DAuth()
    @Get("documents")
    async readDocuments(@DUser() user: User) {
        return await this.service.readDocuments(user);
    }
}

import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    ParseIntPipe,
    Post,
    Put,
    Query,
} from "@nestjs/common";
import { User } from "@prisma/client";
import { DAuth } from "src/decorators/auth.decorator";
import { DRole } from "src/decorators/role.decorator";
import { DUser } from "src/decorators/user.decorator";
import { LoginDto } from "src/dtos/auth/login.dto";
import { RegisterDto } from "src/dtos/auth/register.dto";
import { CreateUserDto } from "src/dtos/users/create-user.dto";
import { UpdateMeDto } from "src/dtos/users/update-me.dto";
import { UpdatePasswordDto } from "src/dtos/users/update-password.dto";
import { UpdateUserDto } from "src/dtos/users/update-user.dto";
import { AuthService } from "src/services/auth.service";
import { UsersService } from "src/services/users.service";
import { ApiTags } from "@nestjs/swagger";
import { DecksService } from "src/services/decks.service";
import { FindQueryDto } from "src/dtos/find-query.dto";
import { CreateDeckDto } from "src/dtos/decks/create-deck.dto";
import { UpdateDeckDto } from "src/dtos/decks/update-deck.dto";
import { ShareDeckDto } from "src/dtos/decks/share-deck.dto";
import { LinkByShareCodeDto } from "src/dtos/decks/link-by-share-code.dto";
import { CopyDeckDto } from "src/dtos/decks/copy-deck.dto";

@ApiTags("Deck")
@Controller("decks")
export class DecksController {
    constructor(private service: DecksService) { }

    @DAuth()
    @Post("")
    async create(@DUser() user: User, @Body() createDeckDto: CreateDeckDto) {
        return await this.service.create(user, createDeckDto);
    }

    @DRole()
    @Get("")
    async read(@Query() findQueryDto: FindQueryDto) {
        return await this.service.read(findQueryDto);
    }

    @DAuth()
    @Get("hierarchy")
    async readHierarchy(@DUser() user: User) {
        return await this.service.readHierarchy(user);
    }

    @DAuth()
    @Get("hierarchy1")
    async readHierarchy1(@DUser() user: User, @Query("parentId") parentId: number | null) {
        return await this.service.readHierarchy1(user,parentId);
    }


    @DAuth()
    @Get("me")
    async readMe(@DUser() user: User) {
        return await this.service.readMine(user);
    }

    
    @DRole()
    @Get(":id")
    async readOne(@Param("id", ParseIntPipe) id: number) {
        return await this.service.readOne(id);
    }

    @DAuth()
    @Put(":id")
    async update(
        @DUser() user: User,
        @Param("id", ParseIntPipe) id: number,
        @Body() updateDeckDto: UpdateDeckDto,
    ) {
        return await this.service.update(user, id, updateDeckDto);
    }

    // Admin: copy a deck (its sub-decks, cards and media) into another Decks Package.
    @DRole()
    @Post(":id/copy")
    async copy(
        @DUser() user: User,
        @Param("id", ParseIntPipe) id: number,
        @Body() dto: CopyDeckDto,
    ) {
        return await this.service.copy(user, id, dto.parent_id ?? null);
    }

    @DRole()
    @Delete(":id")
    async delete(@Param("id", ParseIntPipe) id: number) {
        return await this.service.delete(id);
    }

    @DAuth()
    @Delete("unlink/:id")
    async unlink(@DUser() user: User, @Param("id", ParseIntPipe) id: number) {
        return await this.service.unlink(user, id);
    }

    @DAuth()
    @Put("share/:id")
    async share(
        @DUser() user: User,
        @Param("id", ParseIntPipe) id: number,
        @Body() shareDeckDto: ShareDeckDto,
    ) {
        return await this.service.getShareCode(user, id, shareDeckDto);
    }

    @DAuth()
    @Post("link-by-share-code/")
    async linkByShareCode(
        @DUser() user: User,
        @Param("id", ParseIntPipe) id: number,
        @Body() linkByShareCodeDto: LinkByShareCodeDto,
    ) {
        return await this.service.linkByShareCode(
            user,
            linkByShareCodeDto.code,
        );
    }
}

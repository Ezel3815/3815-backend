import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Prisma, User, UserStatus } from "@prisma/client";
import { PrismaService } from "nestjs-prisma";
import { JwtConstant } from "src/constants/jwt.constant";
import { ActivateUserDto } from "src/dtos/auth/activate-user.dto";
import { LoginDto } from "src/dtos/auth/login.dto";
import { RegisterDto } from "src/dtos/auth/register.dto";
import { RequestResetPasswordDto } from "src/dtos/auth/request-reset-password.dto";
import { ResetPasswordDto } from "src/dtos/auth/reset-passwrod.dto";
import { UserOutDto } from "src/dtos/users/user.out-dto";
import { GenerateBadRequestException } from "src/exception/bad-request.exception";
import { GenerateUnauthorizedException } from "src/exception/unauthorized.exception";
import { EmailService } from "./email.service";
import { generateRandomCode } from "src/utils/code-generation.utils";
import * as md5 from "md5";
import { v7 as uuid } from "uuid";
import { ResendActivationCodeDto } from "src/dtos/auth/resend-activation-code.dto";
import { GenerateUnprocessableEntityException } from "src/exception/unprocessable-entity.exception";
import { on } from "events";

@Injectable()
export class AuthService {
    constructor(
        private prismaService: PrismaService,
        private jwtService: JwtService,
        private emailSerivce: EmailService,
    ) {}

    async isUsernameAvailable(username: string) {
        const taken = await this.prismaService.user.findUnique({
            where: { username: username.trim().toLowerCase() },
        });
        return { available: !taken };
    }

    private async assertUsernameFree(username: string) {
        const taken = await this.prismaService.user.findUnique({
            where: { username },
        });
        if (taken) GenerateBadRequestException(["Username already taken"]);
    }

    async regiser(registerDto: RegisterDto) {
        const alreadyExisted = await this.prismaService.user.findUnique({
            where: { email: registerDto.email },
        });

        if (alreadyExisted && alreadyExisted.status !== UserStatus.PENDING) {
            GenerateBadRequestException(["Already Existed User"]);
        }

        if (alreadyExisted && alreadyExisted.status === UserStatus.PENDING) {
            await this.prismaService.user.delete({
                where: { email: registerDto.email },
            });
        }

        const username = registerDto.username.trim().toLowerCase();
        await this.assertUsernameFree(username);

        const activation_code = generateRandomCode(6);

        const user = await this.prismaService.user.create({
            data: {
                ...registerDto,
                username,
                password: md5(registerDto.password),
                activation_code,
                status: UserStatus.ACTIVE,
                session_code: uuid(),
            },
        });

        this.emailSerivce.sendVerificationEmail(user);

        return {
            user: UserOutDto(user),
            token: this.jwtService.sign({
                id: user.id,
                role: user.role,
                session_code: user.session_code,
            }),
        };
    }

    async regiserWithOutCode(registerDto: RegisterDto) {
        const alreadyExisted = await this.prismaService.user.findUnique({
            where: { email: registerDto.email },
        });

        if (alreadyExisted) {
            GenerateBadRequestException(["Already Existed User"]);
        }

        const username = registerDto.username.trim().toLowerCase();
        await this.assertUsernameFree(username);

        const user = await this.prismaService.user.create({
            data: {
                email: registerDto.email,
                name: registerDto.name,
                username,
                study_year: registerDto.study_year ?? null,
                password: md5(registerDto.password),
                status: UserStatus.ACTIVE,
            },
        });

        return {
            user: UserOutDto(user),
            token: this.jwtService.sign({
                id: user.id,
                role: user.role,
                session_code: user.session_code,
            }),
        };
    }

    async resedActivationCode(resedActivationCodeDto: ResendActivationCodeDto) {
        const alreadyExisted = await this.prismaService.user.findUnique({
            where: { email: resedActivationCodeDto.email },
        });

        if (!alreadyExisted || alreadyExisted.status == UserStatus.ACTIVE) {
            GenerateBadRequestException([
                "You can't send code to an already acitvated or not existed account",
            ]);
        }

        const newActivationCode = generateRandomCode(6);

        const user = await this.prismaService.user.update({
            where: { id: alreadyExisted.id },
            data: {
                activation_code: newActivationCode,
            },
        });

        this.emailSerivce.sendVerificationEmail(user);
    }

    async activateUser(activateUserDto: ActivateUserDto) {
        const user = await this.prismaService.user.findFirst({
            where: {
                email: activateUserDto.email,
                activation_code: activateUserDto.code,
            },
        });

        if (!user) GenerateBadRequestException(["Wrong Code"]);

        const updatedUser = await this.prismaService.user.update({
            where: { id: user.id },
            data: {
                status: UserStatus.ACTIVE,
                activation_code: null,
            },
        });

        return {
            user: UserOutDto(updatedUser),
            token: this.jwtService.sign({
                id: updatedUser.id,
                role: updatedUser.role,
                session_code: updatedUser.session_code,
            }),
        };

        //return UserOutDto(updatedUser);
    }

    async requestRestPassword(requestRestPasswordDto: RequestResetPasswordDto) {
        const user = await this.prismaService.user.findFirst({
            where: {
                email: requestRestPasswordDto.email,
            },
        });

        if (!user) GenerateBadRequestException(["Wrong Email"]);

        const code = generateRandomCode(6);

        const updatedUser = await this.prismaService.user.update({
            where: { id: user.id },
            data: {
                status: UserStatus.ACTIVE,
                reset_password_code: code,
            },
        });

        // Wait for the result so a failed email is reported to the app
        // instead of silently telling the user "code sent".
        const sent = await this.emailSerivce.sendResetPasswordEmail(updatedUser);
        if (!sent) {
            GenerateBadRequestException([
                "Could not send the email right now, please try again later",
            ]);
        }

        return UserOutDto(updatedUser);
    }

    async resetPassword(resetPasswordDto: ResetPasswordDto) {
        const user = await this.prismaService.user.findFirst({
            where: {
                email: resetPasswordDto.email,
                reset_password_code: resetPasswordDto.code,
            },
        });

        if (!user) GenerateBadRequestException(["Wrong email or code"]);

        const updatedUser = await this.prismaService.user.update({
            where: {
                id: user.id,
            },
            data: {
                password: md5(resetPasswordDto.password),
                reset_password_code: null,
            },
        });

        return UserOutDto(updatedUser);
    }

    async login(loginDto: LoginDto) {
        try {
            const user = await this.prismaService.user.update({
                where: {
                    email: loginDto.email,
                    password: md5(loginDto.password),
                },
                data: { session_code: uuid() },
            });

            return {
                user: UserOutDto(user),
                token: this.jwtService.sign({
                    id: user.id,
                    role: user.role,
                    session_code: user.session_code,
                }),
            };
        } catch (e) {
            GenerateBadRequestException(["Bad Credentials"]);
        }
    }

    async getUserFromToken(token: string) {
        const payload = this.jwtService.verify(token, {
            secret: JwtConstant.secret,
        });

        return await this.prismaService.user.findUnique({
            where: { id: payload.id, session_code: payload.session_code },
        });
    }
}

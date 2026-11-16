import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class AdminSetPasswordDto {
    @IsEmail()
    email: string;

    // Leave it out and the server makes a random temporary password.
    @IsOptional()
    @MaxLength(30)
    @MinLength(6)
    @IsString()
    password?: string;
}

import { IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { STUDY_YEARS } from "src/utils/study-year";


export class RegisterDto {
    @IsString({ message: 'Name must be a string.' })
    @MinLength(3, { message: 'Name must be at least 3 characters long.' })
    @MaxLength(30, { message: 'Name must be at most 30 characters long.' })
    name: string;

    @IsString({ message: 'Username must be a string.' })
    @MinLength(3, { message: 'Username must be at least 3 characters long.' })
    @MaxLength(20, { message: 'Username must be at most 20 characters long.' })
    @Matches(/^[a-zA-Z0-9_.]+$/, {
        message: 'Username can only contain letters, numbers, "_" and ".".',
    })
    username: string;

    @IsEmail({}, { message: 'Email must be a valid email address.' })
    email: string;

    @IsString({ message: 'Password must be a string.' })
    @MinLength(6, { message: 'Password must be at least 6 characters long.' })
    @MaxLength(30, { message: 'Password must be at most 30 characters long.' })
    password: string;

    /// Optional so older app versions can still register; the app asks for it.
    @IsOptional()
    @IsString()
    @IsIn(STUDY_YEARS as unknown as string[], { message: "Invalid study year." })
    study_year?: string;
}

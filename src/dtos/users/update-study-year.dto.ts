import { IsIn, IsString } from "class-validator";
import { STUDY_YEARS } from "src/utils/study-year";

export class UpdateStudyYearDto {
    @IsString()
    @IsIn(STUDY_YEARS as unknown as string[], { message: "Invalid study year." })
    study_year: string;
}

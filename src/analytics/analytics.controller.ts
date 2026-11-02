import { Controller, Get, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { DRole } from "src/decorators/role.decorator";
import { AnalyticsService } from "./analytics.service";

// Admin-only, read-only. ?tz=3 = hours ahead of UTC for the app's users (default 3). ?refresh=1 skips the 10 minute cache.
@ApiTags("Analytics")
@Controller("analytics")
export class AnalyticsController {
    constructor(private s: AnalyticsService) {}

    @DRole()
    @Get()
    report(@Query("tz") tz?: string, @Query("refresh") refresh?: string) {
        return this.s.report(tz, refresh === "1" || refresh === "true");
    }
}

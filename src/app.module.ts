import {
    MiddlewareConsumer,
    Module,
    NestMiddleware,
    NestModule,
} from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { PrismaModule } from "nestjs-prisma";
import { AuthController } from "./controllers/auth.controller";
import { AuthService } from "./services/auth.service";
import { JwtModule } from "@nestjs/jwt";
import { JwtConstant } from "./constants/jwt.constant";
import { UsersController } from "./controllers/users.controller";
import { UsersService } from "./services/users.service";
import { AuthMiddleware } from "./middlewares/auth.middleware";
import { EmailService } from "./services/email.service";
import { CodesController } from "./controllers/codes.controller";
import { DecksController } from "./controllers/decks.controller";
import { CodesService } from "./services/codes.service";
import { DecksService } from "./services/decks.service";
import { DecksCardsController } from "./controllers/decks-cards.controller";
import { DecksCardsService } from "./services/decks-cards.service";
import { MediaController } from "./controllers/media.controller";
import { MediaService } from "./services/media.service";
import { ImageRestoreController } from "./controllers/image-restore.controller";
import { ServeStaticModule } from "@nestjs/serve-static";
import { join } from "path";
import { MosaicController } from "./controllers/mosaic.controller";
import { MosaicService } from "./mosaic/mosaic.service";

@Module({
    imports: [
        PrismaModule,
        JwtModule.register({
            secret: JwtConstant.secret,
        }),
        ServeStaticModule.forRoot({
            rootPath: join(__dirname, "..", "..", "public"),
            serveRoot: "/public/",
        }),
    ],
    controllers: [
        AppController,
        AuthController,
        UsersController,
        CodesController,
        DecksController,
        DecksCardsController,
        MediaController,
        ImageRestoreController,
        MosaicController,
    ],
    providers: [
        AppService,
        AuthService,
        UsersService,
        EmailService,
        CodesService,
        DecksService,
        DecksCardsService,
        MediaService,
        MosaicService,
    ],
})
export class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
        consumer.apply(AuthMiddleware).forRoutes("*");
    }
}

import { NestFactory } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { ValidationPipe } from "@nestjs/common";
import { join } from "path";
import { AllExceptionsFilter } from "./filter/all-exceptions.filter";
import { PrismaExceptionFilter } from "./filter/prisma-exception.filter";

// FIX: on a free-tier host, Prisma's default pool size (2x CPU cores + 1)
// can exceed what the free-tier database plan actually allows, and every
// slot that fills up waits up to Prisma's default 10s before failing with
// "Timed out fetching a new connection from the connection pool" — which
// the app then shows as a generic "Something went wrong".
//
// This sets a small, safe pool size and a longer queue timeout directly in
// code, so it's guaranteed even if the DATABASE_URL environment variable on
// the host is never touched. It only fills in params that aren't already
// present, so setting them explicitly in the Render env var (or bumping
// them there later, e.g. after upgrading the database plan) still wins.
function applyDatabasePoolDefaults() {
    const url = process.env.DATABASE_URL;
    if (!url) return;

    const [base, query = ""] = url.split("?");
    const params = new URLSearchParams(query);
    if (!params.has("connection_limit")) params.set("connection_limit", "5");
    if (!params.has("pool_timeout")) params.set("pool_timeout", "20");
    process.env.DATABASE_URL = `${base}?${params.toString()}`;
    console.log(`[db] pool: connection_limit=${params.get("connection_limit")} pool_timeout=${params.get("pool_timeout")}`);
}
applyDatabasePoolDefaults();

async function bootstrap() {
    const app = await NestFactory.create(AppModule);

    const config = new DocumentBuilder()
        .setTitle("Flash Cards Project")
        .addBasicAuth({ type: "apiKey", name: "authorization", in: "header" })
        .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("api", app, document);

    // PrismaExceptionFilter must come first: Nest checks filters in order
    // and picks the first one whose @Catch() type matches. AllExceptionsFilter
    // has no type (@Catch() with no args), so it matches everything - if it
    // were first, PrismaExceptionFilter would never run.
    app.useGlobalFilters(new PrismaExceptionFilter(), new AllExceptionsFilter());

    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    app.enableCors();
    console.log("App running on " + (process.env.PORT ?? 3000));
    await app.listen(process.env.PORT ?? 3000);
}
console.log("........................");
bootstrap();

import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { PipelineService } from "./pipeline.service";

// Runs queued pipeline jobs outside the student API (GitHub Actions). Usage: node dist/src/pipeline/worker.js
process.env.PIPELINE_WORKER = "1";
const MAX_MIN = Number(process.env.WORKER_MAX_MINUTES) || 325; // GitHub job limit is 360

async function main() {
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn", "log"] });
    try { await app.get(PipelineService).runAsWorker(MAX_MIN * 60_000); }
    finally { await app.close(); }
    process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

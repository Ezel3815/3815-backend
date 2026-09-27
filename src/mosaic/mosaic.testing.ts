import { PrismaClient } from "@prisma/client";

/**
 * Test-only helper for the DB-backed mosaic specs (never imported by app code).
 *   MOSAIC_TEST_DATABASE_URL=mysql://user:pass@127.0.0.1:3306/mosaic_test   (required, else the suite is skipped)
 * Needs the native Prisma query-engine binary (downloaded by `prisma generate`
 * with normal network access — this suite cannot run in a network-restricted
 * sandbox, see PHASE2_VERIFICATION.md). The database must already have every
 * migration in prisma/migrations applied.
 */
export function createTestPrisma(): PrismaClient {
    return new PrismaClient({ datasourceUrl: process.env.MOSAIC_TEST_DATABASE_URL! });
}

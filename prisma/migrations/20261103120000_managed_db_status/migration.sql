-- CreateEnum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DatabaseStatus') THEN
        CREATE TYPE "DatabaseStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'UNHEALTHY', 'FAILED', 'DELETING');
    END IF;
END $$;

-- AlterTable
ALTER TABLE "database_instances" ADD COLUMN IF NOT EXISTS "status" "DatabaseStatus" NOT NULL DEFAULT 'PROVISIONING',
ADD COLUMN IF NOT EXISTS "lastHealthAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "host" TEXT,
ADD COLUMN IF NOT EXISTS "port" INTEGER,
ADD COLUMN IF NOT EXISTS "containerId" TEXT;

-- Backfill: instances created before status tracking were already provisioned
UPDATE "database_instances" SET "status" = 'ACTIVE' WHERE "status" = 'PROVISIONING' AND "connectionUrl" <> '';

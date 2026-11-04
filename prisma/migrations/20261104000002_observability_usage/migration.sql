-- Team B: persistent deployment logs, metric samples, usage metering and scale-to-zero

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;

-- AlterTable
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "lastRequestAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "usageWarnedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "spendCapReachedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "deployment_logs" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "stream" TEXT NOT NULL,
    "line" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployment_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "metric_samples" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "deploymentId" TEXT,
    "containerId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "cpuPercent" DOUBLE PRECISION NOT NULL,
    "memoryMb" DOUBLE PRECISION NOT NULL,
    "memoryLimitMb" DOUBLE PRECISION,
    "netRxBytes" DOUBLE PRECISION,
    "netTxBytes" DOUBLE PRECISION,
    "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "deployment_logs_deploymentId_seq_idx" ON "deployment_logs"("deploymentId", "seq");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "deployment_logs_ts_idx" ON "deployment_logs"("ts");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "metric_samples_serviceId_sampledAt_idx" ON "metric_samples"("serviceId", "sampledAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "metric_samples_deploymentId_sampledAt_idx" ON "metric_samples"("deploymentId", "sampledAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "metric_samples_sampledAt_idx" ON "metric_samples"("sampledAt");

-- CreateIndex (nothing wrote usage_records before this migration, so no duplicates exist)
CREATE UNIQUE INDEX IF NOT EXISTS "usage_records_serviceId_resourceType_periodStart_key" ON "usage_records"("serviceId", "resourceType", "periodStart");

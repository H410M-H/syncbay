-- Team B (v1.2): live analytics + per-service HTTP traffic. Additive only.
-- CreateTable
CREATE TABLE "traffic_samples" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "deploymentId" TEXT,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "s2xx" INTEGER NOT NULL DEFAULT 0,
    "s3xx" INTEGER NOT NULL DEFAULT 0,
    "s4xx" INTEGER NOT NULL DEFAULT 0,
    "s5xx" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "bytesIn" BIGINT NOT NULL DEFAULT 0,
    "bytesOut" BIGINT NOT NULL DEFAULT 0,
    "latencySumMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latencyMaxMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lt50" INTEGER NOT NULL DEFAULT 0,
    "lt200" INTEGER NOT NULL DEFAULT 0,
    "lt1000" INTEGER NOT NULL DEFAULT 0,
    "ge1000" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traffic_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "traffic_samples_serviceId_bucketStart_idx" ON "traffic_samples"("serviceId", "bucketStart");

-- CreateIndex
CREATE INDEX "traffic_samples_deploymentId_bucketStart_idx" ON "traffic_samples"("deploymentId", "bucketStart");

-- CreateIndex
CREATE INDEX "traffic_samples_bucketStart_idx" ON "traffic_samples"("bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "traffic_samples_serviceId_deploymentId_bucketStart_key" ON "traffic_samples"("serviceId", "deploymentId", "bucketStart");

-- CreateIndex
CREATE INDEX "deployments_status_createdAt_idx" ON "deployments"("status", "createdAt");

-- CreateIndex
CREATE INDEX "deployments_serviceId_createdAt_idx" ON "deployments"("serviceId", "createdAt");


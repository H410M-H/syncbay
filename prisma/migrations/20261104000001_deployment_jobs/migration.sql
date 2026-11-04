-- Team A: durable deployment queue (DeploymentJob), runner pull consumer leases, deployment placement
-- CreateEnum
CREATE TYPE "DeploymentJobStatus" AS ENUM ('PENDING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "assignedPort" INTEGER,
ADD COLUMN     "runnerDriver" TEXT;

-- CreateTable
CREATE TABLE "deployment_jobs" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'deploy',
    "mode" TEXT NOT NULL DEFAULT 'push',
    "deploymentId" TEXT,
    "buildId" TEXT,
    "serviceId" TEXT,
    "status" "DeploymentJobStatus" NOT NULL DEFAULT 'PENDING',
    "driverType" TEXT,
    "runnerJobId" TEXT,
    "options" JSONB,
    "payload" JSONB,
    "targetContainerId" TEXT,
    "targetRunnerId" TEXT,
    "runnerId" TEXT,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "orchestratorLeaseUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "result" JSONB,
    "exitCode" INTEGER,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployment_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deployment_jobs_deploymentId_key" ON "deployment_jobs"("deploymentId");

-- CreateIndex
CREATE INDEX "deployment_jobs_status_mode_createdAt_idx" ON "deployment_jobs"("status", "mode", "createdAt");

-- CreateIndex
CREATE INDEX "deployment_jobs_status_leaseExpiresAt_idx" ON "deployment_jobs"("status", "leaseExpiresAt");

-- AddForeignKey
ALTER TABLE "deployment_jobs" ADD CONSTRAINT "deployment_jobs_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;


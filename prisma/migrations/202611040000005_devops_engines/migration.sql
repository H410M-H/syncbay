-- CreateTable
CREATE TABLE "cron_jobs" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'GET',
    "headers" JSONB,
    "body" TEXT,
    "timeoutMs" INTEGER NOT NULL DEFAULT 10000,
    "maxRetries" INTEGER NOT NULL DEFAULT 2,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastDurationMs" INTEGER,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cron_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cron_runs" (
    "id" TEXT NOT NULL,
    "cronJobId" TEXT NOT NULL,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "status" TEXT NOT NULL,
    "statusCode" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "url" TEXT NOT NULL,
    "responseSnippet" TEXT,
    "error" TEXT,

    CONSTRAINT "cron_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waf_rules" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "rateLimitRpm" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "lastHitAt" TIMESTAMP(3),
    "lastHitIp" TEXT,
    "lastHitPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "waf_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canary_configs" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "stableDeploymentId" TEXT NOT NULL,
    "canaryDeploymentId" TEXT NOT NULL,
    "stableUpstreamUrl" TEXT NOT NULL,
    "canaryUpstreamUrl" TEXT NOT NULL,
    "weightPercent" INTEGER NOT NULL DEFAULT 10,
    "autoRollbackThreshold5xxPercent" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "stableRequests" INTEGER NOT NULL DEFAULT 0,
    "canaryRequests" INTEGER NOT NULL DEFAULT 0,
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastErrorRatePercent" DOUBLE PRECISION,
    "lastHealthy" BOOLEAN,
    "lastReason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canary_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cron_jobs_serviceId_idx" ON "cron_jobs"("serviceId");

-- CreateIndex
CREATE INDEX "cron_jobs_enabled_nextRunAt_idx" ON "cron_jobs"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "cron_runs_cronJobId_executedAt_idx" ON "cron_runs"("cronJobId", "executedAt");

-- CreateIndex
CREATE INDEX "waf_rules_serviceId_idx" ON "waf_rules"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "canary_configs_serviceId_key" ON "canary_configs"("serviceId");

-- AddForeignKey
ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cron_runs" ADD CONSTRAINT "cron_runs_cronJobId_fkey" FOREIGN KEY ("cronJobId") REFERENCES "cron_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waf_rules" ADD CONSTRAINT "waf_rules_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canary_configs" ADD CONSTRAINT "canary_configs_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Health monitor: probe state per deployment and the last automatic restart per service.
-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "healthFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastHealthyAt" TIMESTAMP(3),
ADD COLUMN     "lastProbeAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "services" ADD COLUMN     "lastAutoHealAt" TIMESTAMP(3);


-- Staff console (/admin): staff roles, append-only staff audit, suspensions, moderation, CRM notes.
-- Also the indexes the console queries need (audit log by workspace, projects by workspace, services by environment).
-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'MODERATOR', 'BILLING', 'VIEWER');

-- AlterTable
ALTER TABLE "services" ADD COLUMN     "moderationLockedAt" TIMESTAMP(3),
ADD COLUMN     "moderationReason" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedReason" TEXT;

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "lifecycleStage" TEXT,
ADD COLUMN     "staffTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedById" TEXT,
ADD COLUMN     "suspendedReason" TEXT;

-- CreateTable
CREATE TABLE "staff_members" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "grantedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "staff_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_audit_events" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorRole" TEXT,
    "action" TEXT NOT NULL,
    "permission" TEXT,
    "outcome" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "workspaceId" TEXT,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abuse_reports" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "url" TEXT,
    "targetHost" TEXT,
    "serviceId" TEXT,
    "workspaceId" TEXT,
    "description" TEXT NOT NULL,
    "reporterEmail" TEXT,
    "reporterIp" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "assigneeId" TEXT,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abuse_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_notes" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "customer_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_members_userId_key" ON "staff_members"("userId");

-- CreateIndex
CREATE INDEX "staff_audit_events_createdAt_idx" ON "staff_audit_events"("createdAt");

-- CreateIndex
CREATE INDEX "staff_audit_events_targetType_targetId_idx" ON "staff_audit_events"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "staff_audit_events_actorUserId_createdAt_idx" ON "staff_audit_events"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "abuse_reports_status_priority_createdAt_idx" ON "abuse_reports"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "abuse_reports_targetHost_idx" ON "abuse_reports"("targetHost");

-- CreateIndex
CREATE INDEX "customer_notes_workspaceId_createdAt_idx" ON "customer_notes"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_entries_workspaceId_createdAt_idx" ON "audit_log_entries"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "projects_workspaceId_idx" ON "projects"("workspaceId");

-- CreateIndex
CREATE INDEX "services_environmentId_idx" ON "services"("environmentId");

-- AddForeignKey
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Staff audit events are append-only: reject UPDATE and DELETE at the database.
CREATE OR REPLACE FUNCTION staff_audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'staff_audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER staff_audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON "staff_audit_events"
  FOR EACH ROW EXECUTE FUNCTION staff_audit_events_append_only();

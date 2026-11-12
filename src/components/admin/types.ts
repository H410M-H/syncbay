/**
 * Row shapes of the staff console API (`src/server/routers/admin.ts`) for the procedures whose
 * output tRPC infers as `any` (rows mapped through `(r: any) => …`). Kept in step with the
 * explicit `select`s there. Dates arrive as `Date` (superjson).
 */

import type { StaffRoleName } from "@/lib/admin/permissions";

export const LIFECYCLE_STAGES = ["TRIAL", "ACTIVE", "AT_RISK", "CHURNED", "ENTERPRISE"] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const REPORT_STATUSES = ["OPEN", "IN_REVIEW", "ACTIONED", "DISMISSED"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const AUDIT_OUTCOMES = ["ALLOWED", "DENIED", "FAILED"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export interface ActivityItem {
  kind: string;
  id: string;
  at: Date;
  text: string;
  workspaceId: string | null;
  workspaceSlug: string | null;
}

export interface RecentFailure {
  id: string;
  createdAt: Date;
  error: string;
  serviceId: string | null;
  serviceName: string | null;
  workspaceId: string | null;
  workspaceSlug: string | null;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  isPersonal: boolean;
  createdAt: Date;
  suspendedAt: Date | null;
  lifecycleStage: string | null;
  staffTags: string[];
  spendingCapCents: number | null;
  creditBalanceCents: number | null;
  _count: { members: number; projects: number };
  ownerEmail: string | null;
}

export interface UserRow {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  createdAt: Date;
  suspendedAt: Date | null;
  providers: string[];
  memberships: Array<{ role: string; workspace: { id: string; slug: string } }>;
  staffRole: StaffRoleName | null;
}

export interface ReportRow {
  id: string;
  category: string;
  priority: number;
  url: string | null;
  targetHost: string | null;
  serviceId: string | null;
  workspaceId: string | null;
  description: string;
  reporterEmail: string | null;
  status: ReportStatus;
  assigneeId: string | null;
  resolution: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  service: { id: string; name: string; moderationLockedAt: Date | null } | null;
}

export interface StaffRow {
  id: string;
  role: StaffRoleName;
  note: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  grantedById: string | null;
  user: { id: string; name: string | null; email: string; image: string | null };
  pinned: boolean;
}

export interface AuditRow {
  id: string;
  createdAt: Date;
  actorUserId: string | null;
  actorRole: string | null;
  actorEmail: string | null;
  action: string;
  permission: string | null;
  outcome: AuditOutcome;
  targetType: string | null;
  targetId: string | null;
  workspaceId: string | null;
  reason: string | null;
}

export interface NoteRow {
  id: string;
  body: string;
  pinned: boolean;
  createdAt: Date;
  authorId: string;
  author: { id: string; email: string; name: string | null } | null;
}

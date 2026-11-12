import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getStaffIdentity } from "@/lib/admin/staff";
import { can } from "@/lib/admin/permissions";
import { AdminNav, type AdminNavItem } from "@/components/admin/admin-nav";
import { StaffProvider } from "@/components/admin/staff-context";
import { humanize, roleBadgeClass } from "@/components/admin/format";
import styles from "@/components/admin/admin.module.css";

export const metadata: Metadata = {
  title: "Staff console",
  robots: { index: false, follow: false },
};

/**
 * Staff console shell. Signed-out visitors go to sign-in; signed-in non-staff get a plain 404 so
 * the console's existence is not confirmed (the API answers NOT_FOUND the same way).
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/auth/signin?callbackUrl=/admin");

  const staff = await getStaffIdentity(session.user.id);
  if (!staff) notFound();

  const nav: AdminNavItem[] = [
    { href: "/admin", label: "Overview", icon: "⬡" },
    { href: "/admin/workspaces", label: "Workspaces", icon: "◫" },
    { href: "/admin/users", label: "Users", icon: "◎" },
    { href: "/admin/moderation", label: "Moderation", icon: "⚑" },
    ...(can(staff.role, "audit.read_own") ? [{ href: "/admin/audit", label: "Audit log", icon: "⊟" }] : []),
    ...(can(staff.role, "staff.read") ? [{ href: "/admin/staff", label: "Staff", icon: "🛡" }] : []),
  ];

  return (
    <StaffProvider value={{ userId: staff.userId, email: session.user.email ?? null, role: staff.role, pinned: staff.pinned }}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <Link href="/admin" className={styles.brand}>
            Syncbay <span className={styles.brandTag}>Staff console</span>
          </Link>
          <div className={styles.headerRight}>
            <span className={roleBadgeClass(staff.role)} title={staff.pinned ? "Set by SUPER_ADMIN_EMAILS" : undefined}>
              {humanize(staff.role)}
              {staff.pinned ? " · pinned" : ""}
            </span>
            {session.user.email && <span className={styles.email}>{session.user.email}</span>}
            <Link href="/dashboard" className="btn btn-secondary btn-sm">
              ← Customer dashboard
            </Link>
          </div>
        </header>
        <AdminNav items={nav} />
        <main className={styles.main} id="admin-main">
          {children}
        </main>
      </div>
    </StaffProvider>
  );
}

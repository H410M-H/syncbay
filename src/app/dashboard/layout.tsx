import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { DashboardShell } from "./dashboard-shell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);
  if (!session) {
    const headersList = await headers();
    const pathname = headersList.get("x-pathname") || "/dashboard";
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(pathname)}`);
  }

  return (
    <DashboardShell
      user={{
        id: session.user?.id,
        name: session.user?.name,
        email: session.user?.email,
      }}
    >
      {children}
    </DashboardShell>
  );
}

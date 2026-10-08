"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { useState, useRef, useEffect, createContext, useContext } from "react";

export interface DashboardContextType {
  user: {
    id?: string;
    name?: string | null;
    email?: string | null;
  };
  workspaces: any[] | undefined;
  currentWorkspace: any | undefined;
  setCurrentWorkspaceId: (id: string) => void;
  refetchWorkspaces: () => Promise<any>;
}

export const DashboardContext = createContext<DashboardContextType | null>(null);

export function useDashboard() {
  return useContext(DashboardContext);
}

interface DashboardShellProps {
  user: {
    id?: string;
    name?: string | null;
    email?: string | null;
  };
  children: React.ReactNode;
}

export function DashboardShell({ user, children }: DashboardShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: workspaces, refetch: refetchWorkspaces } = trpc.workspace.list.useQuery();

  const [topbarDropdownOpen, setTopbarDropdownOpen] = useState(false);
  const [sidebarDropdownOpen, setSidebarDropdownOpen] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [newWsSlug, setNewWsSlug] = useState("");
  const [creatingWs, setCreatingWs] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // Collapsible & Mobile states
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Invite modal state
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"ADMIN" | "MEMBER" | "VIEWER">("MEMBER");
  const [inviteDays, setInviteDays] = useState(7);
  const [inviteResult, setInviteResult] = useState<{ token: string; link: string } | null>(null);
  const [inviteError, setInviteError] = useState("");

  const topbarDropdownRef = useRef<HTMLDivElement>(null);
  const sidebarDropdownRef = useRef<HTMLDivElement>(null);

  const createWorkspaceMutation = trpc.workspace.create.useMutation();
  const inviteMutation = trpc.workspace.invite.useMutation();

  // Load and persist sidebar collapsed state
  useEffect(() => {
    if (typeof window !== "undefined") {
      const savedCollapsed = localStorage.getItem("syncbay_sidebar_collapsed");
      if (savedCollapsed !== null) {
        setIsCollapsed(savedCollapsed === "true");
      } else if (window.innerWidth < 1024) {
        setIsCollapsed(true);
      }

      const handleResize = () => {
        if (window.innerWidth < 768) {
          // mobile drawer handles it
        } else if (window.innerWidth < 1024 && savedCollapsed === null) {
          setIsCollapsed(true);
        }
      };
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }
  }, []);

  // Keyboard shortcut Ctrl+B or Cmd+B to toggle collapse
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setIsCollapsed((prev) => {
          const next = !prev;
          if (typeof window !== "undefined") {
            localStorage.setItem("syncbay_sidebar_collapsed", String(next));
          }
          return next;
        });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Lock body scroll and handle Escape key when mobile drawer or modals are open
  useEffect(() => {
    if (typeof window === "undefined") return;

    if (mobileOpen || inviteModalOpen || createModalOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileOpen(false);
        setInviteModalOpen(false);
        setCreateModalOpen(false);
        setTopbarDropdownOpen(false);
        setSidebarDropdownOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobileOpen, inviteModalOpen, createModalOpen]);

  // Touch swipe to close mobile drawer
  const touchStartX = useRef<number | null>(null);
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const diffX = touchStartX.current - e.changedTouches[0].clientX;
    if (diffX > 50) {
      // Swiped left by 50px
      setMobileOpen(false);
    }
    touchStartX.current = null;
  };

  // Close dropdowns on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        topbarDropdownRef.current &&
        !topbarDropdownRef.current.contains(e.target as Node)
      ) {
        setTopbarDropdownOpen(false);
      }
      if (
        sidebarDropdownRef.current &&
        !sidebarDropdownRef.current.contains(e.target as Node)
      ) {
        setSidebarDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Determine current active workspace from path e.g. /dashboard/[slug]
  const pathSegments = pathname.split("/").filter(Boolean);
  const slugInPath =
    pathSegments.length === 2 &&
    pathSegments[0] === "dashboard" &&
    ![
      "projects",
      "settings",
      "members",
      "team",
      "usage",
      "audit",
      "services",
      "databases",
      "buckets",
    ].includes(pathSegments[1])
      ? pathSegments[1]
      : null;

  const [explicitWsId, setExplicitWsId] = useState<string>("");

  useEffect(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("syncbay_active_ws");
      if (stored) setExplicitWsId(stored);
    }
  }, []);

  const currentWorkspace =
    (slugInPath ? workspaces?.find((w) => w.slug === slugInPath) : null) ||
    (explicitWsId ? workspaces?.find((w) => w.id === explicitWsId) : null) ||
    workspaces?.[0];

  const handleSelectWorkspace = (ws: any) => {
    setTopbarDropdownOpen(false);
    setSidebarDropdownOpen(false);
    setExplicitWsId(ws.id);
    if (typeof window !== "undefined") {
      localStorage.setItem("syncbay_active_ws", ws.id);
    }

    if (pathname === "/dashboard" || slugInPath) {
      router.push(`/dashboard/${ws.slug}`);
    }
  };

  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWsName.trim() || !newWsSlug.trim()) return;
    setErrorMsg("");
    setCreatingWs(true);
    try {
      const created = await createWorkspaceMutation.mutateAsync({
        name: newWsName.trim(),
        slug: newWsSlug.trim().toLowerCase(),
      });
      await refetchWorkspaces();
      setCreateModalOpen(false);
      setNewWsName("");
      setNewWsSlug("");
      setExplicitWsId(created.id);
      if (typeof window !== "undefined") {
        localStorage.setItem("syncbay_active_ws", created.id);
      }
      router.push(`/dashboard/${created.slug}`);
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to create workspace");
    } finally {
      setCreatingWs(false);
    }
  };

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentWorkspace?.id || !inviteEmail.trim()) return;
    setInviteError("");
    setInviteResult(null);
    try {
      const res = await inviteMutation.mutateAsync({
        workspaceId: currentWorkspace.id,
        email: inviteEmail.trim(),
        role: inviteRole,
        expiresInDays: inviteDays,
      });
      const link = `${typeof window !== "undefined" ? window.location.origin : ""}/invite/${res.token}`;
      setInviteResult({ token: res.token, link });
      setInviteEmail("");
    } catch (err: any) {
      setInviteError(err.message || "Failed to create invitation. Only workspace OWNER or ADMIN can invite.");
    }
  };

  const toggleCollapse = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        localStorage.setItem("syncbay_sidebar_collapsed", String(next));
      }
      return next;
    });
  };

  const isNavActive = (href: string) => {
    if (href === "/dashboard") {
      return pathname === "/dashboard" || !!slugInPath;
    }
    if (href === "/dashboard/members") {
      return pathname.startsWith("/dashboard/members") || pathname.startsWith("/dashboard/team");
    }
    return pathname.startsWith(href);
  };

  return (
    <DashboardContext.Provider
      value={{
        user,
        workspaces,
        currentWorkspace,
        setCurrentWorkspaceId: (id: string) => {
          setExplicitWsId(id);
          if (typeof window !== "undefined") {
            localStorage.setItem("syncbay_active_ws", id);
          }
        },
        refetchWorkspaces,
      }}
    >
      <div className={`app-shell ${isCollapsed ? "sidebar-collapsed" : ""}`}>
        {/* ── Topbar ── */}
        <header className="topbar">
          {/* Mobile Hamburger Toggle Button */}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="btn btn-ghost btn-sm"
            style={{
              display: "none",
              padding: "8px",
              marginRight: "4px",
              minWidth: "44px",
              minHeight: "44px",
            }}
            id="mobile-nav-toggle"
            aria-label="Toggle Navigation Drawer"
          >
            <span style={{ fontSize: "1.25rem" }}>☰</span>
          </button>
          <style jsx>{`
            @media (max-width: 768px) {
              #mobile-nav-toggle {
                display: inline-flex !important;
              }
            }
          `}</style>

          <Link href="/dashboard" className="logo">
            <div className="logo-icon">
              <Image src="/brand-icon-tight.png" alt="Syncbay" width={22} height={12} priority />
            </div>
            <span style={{ fontWeight: 800 }}>Syncbay</span>
          </Link>

          {/* Official American Company Badge */}
          <span className="us-badge hide-on-mobile" title="Engineered in San Francisco, California · US Cloud Infrastructure">
            <span>🇺🇸</span>
            <span>US Cloud</span>
          </span>

          {/* Dynamic Workspace Switcher Dropdown in Topbar */}
          <div style={{ position: "relative" }} ref={topbarDropdownRef}>
            <button
              onClick={() => setTopbarDropdownOpen(!topbarDropdownOpen)}
              className="btn btn-secondary btn-sm"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "6px 12px",
                background: "var(--bg-card)",
                borderColor: topbarDropdownOpen ? "var(--brand-primary)" : "var(--border-default)",
              }}
              aria-label="Switch Workspace"
            >
              <span style={{ fontSize: "14px" }}>
                {currentWorkspace?.isPersonal ? "👤" : "🏢"}
              </span>
              <span style={{ fontWeight: 600, maxWidth: "130px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {currentWorkspace?.name || "Select Workspace"}
              </span>
              <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>▼</span>
            </button>

            {topbarDropdownOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  left: 0,
                  width: "240px",
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-default)",
                  borderRadius: "var(--radius-md)",
                  boxShadow: "var(--shadow-lg)",
                  padding: "8px",
                  zIndex: 1000,
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                }}
              >
                <div
                  style={{
                    fontSize: "0.7rem",
                    fontWeight: 700,
                    color: "var(--text-muted)",
                    padding: "4px 8px",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  Workspaces
                </div>

                {workspaces?.map((ws) => (
                  <button
                    key={ws.id}
                    onClick={() => handleSelectWorkspace(ws)}
                    className="btn btn-ghost btn-sm"
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "8px 10px",
                      borderRadius: "var(--radius-sm)",
                      background: ws.id === currentWorkspace?.id ? "rgba(99,102,241,0.15)" : "transparent",
                      color: ws.id === currentWorkspace?.id ? "var(--brand-primary)" : "var(--text-primary)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", overflow: "hidden" }}>
                      <span>{ws.isPersonal ? "👤" : "🏢"}</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {ws.name}
                      </span>
                    </div>
                    {ws.id === currentWorkspace?.id && (
                      <span style={{ fontSize: "12px", color: "var(--brand-primary)" }}>✓</span>
                    )}
                  </button>
                ))}

                <hr style={{ border: "none", borderTop: "1px solid var(--border-subtle)", margin: "4px 0" }} />

                <button
                  onClick={() => {
                    setTopbarDropdownOpen(false);
                    setCreateModalOpen(true);
                  }}
                  className="btn btn-ghost btn-sm"
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    color: "var(--brand-primary)",
                    justifyContent: "flex-start",
                    padding: "8px 10px",
                  }}
                >
                  <span>＋</span> Create Team Workspace
                </button>
              </div>
            )}
          </div>

          <div style={{ flex: 1 }} />

          {/* Quick Invite Button */}
          <button
            onClick={() => setInviteModalOpen(true)}
            className="btn btn-secondary btn-sm hide-on-mobile"
            style={{ fontSize: "0.75rem", padding: "5px 10px" }}
          >
            ✉️ Invite
          </button>

          {/* User profile & sign out */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div
                style={{
                  width: "28px",
                  height: "28px",
                  borderRadius: "50%",
                  background: "linear-gradient(135deg, var(--brand-primary), var(--brand-secondary))",
                  display: "grid",
                  placeItems: "center",
                  fontSize: "12px",
                  fontWeight: 700,
                  color: "#fff",
                  flexShrink: 0,
                }}
              >
                {user.name ? user.name.slice(0, 1).toUpperCase() : user.email?.slice(0, 1).toUpperCase() || "U"}
              </div>
              <span
                style={{
                  fontSize: "0.8125rem",
                  color: "var(--text-secondary)",
                  maxWidth: "140px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                className="hide-on-mobile"
              >
                {user.email}
              </span>
            </div>

            <form action="/api/auth/signout" method="POST">
              <button
                type="submit"
                className="btn btn-ghost btn-sm"
                style={{ color: "var(--text-muted)", padding: "4px 8px" }}
              >
                Sign out
              </button>
            </form>
          </div>
        </header>

        {/* ── Modern Collapsible Desktop Sidebar ── */}
        <nav className={`sidebar ${isCollapsed ? "is-collapsed" : ""}`}>
          {/* Dynamic Workspace Selector */}
          {!isCollapsed ? (
            <div style={{ position: "relative", marginBottom: "12px" }} ref={sidebarDropdownRef}>
              <button
                onClick={() => setSidebarDropdownOpen(!sidebarDropdownOpen)}
                className="btn btn-secondary"
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: "var(--radius-md)",
                  background: "var(--bg-overlay)",
                  border: sidebarDropdownOpen ? "1px solid var(--brand-primary)" : "1px solid var(--border-subtle)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  textAlign: "left",
                  cursor: "pointer",
                }}
                aria-label="Switch Workspace"
              >
                <div style={{ overflow: "hidden", display: "flex", alignItems: "center", gap: "10px" }}>
                  <span style={{ fontSize: "16px" }}>{currentWorkspace?.isPersonal ? "👤" : "🏢"}</span>
                  <div style={{ overflow: "hidden" }}>
                    <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Workspace
                    </div>
                    <div style={{ fontWeight: 700, fontSize: "0.875rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-primary)" }}>
                      {currentWorkspace?.name || "Personal"}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span className="badge badge-queued" style={{ fontSize: "0.65rem", padding: "2px 6px" }}>
                    {currentWorkspace?.isPersonal ? "Personal" : "Team"}
                  </span>
                  <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>▼</span>
                </div>
              </button>

              {sidebarDropdownOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 4px)",
                    left: 0,
                    right: 0,
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-default)",
                    borderRadius: "var(--radius-md)",
                    boxShadow: "var(--shadow-lg)",
                    padding: "8px",
                    zIndex: 1000,
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.7rem",
                      fontWeight: 700,
                      color: "var(--text-muted)",
                      padding: "4px 8px",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                    }}
                  >
                    Select Workspace
                  </div>

                  {workspaces?.map((ws) => (
                    <button
                      key={ws.id}
                      onClick={() => handleSelectWorkspace(ws)}
                      className="btn btn-ghost btn-sm"
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "8px 10px",
                        borderRadius: "var(--radius-sm)",
                        background: ws.id === currentWorkspace?.id ? "rgba(99,102,241,0.15)" : "transparent",
                        color: ws.id === currentWorkspace?.id ? "var(--brand-primary)" : "var(--text-primary)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", overflow: "hidden" }}>
                        <span>{ws.isPersonal ? "👤" : "🏢"}</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {ws.name}
                        </span>
                      </div>
                      {ws.id === currentWorkspace?.id && (
                        <span style={{ fontSize: "12px", color: "var(--brand-primary)" }}>✓</span>
                      )}
                    </button>
                  ))}

                  <hr style={{ border: "none", borderTop: "1px solid var(--border-subtle)", margin: "4px 0" }} />

                  <button
                    onClick={() => {
                      setSidebarDropdownOpen(false);
                      setCreateModalOpen(true);
                    }}
                    className="btn btn-ghost btn-sm"
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      color: "var(--brand-primary)",
                      justifyContent: "flex-start",
                      padding: "8px 10px",
                    }}
                  >
                    <span>＋</span> Create Team Workspace
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div
              style={{ position: "relative", marginBottom: "12px", width: "100%", display: "flex", justifyContent: "center" }}
              ref={sidebarDropdownRef}
            >
              <button
                onClick={() => setSidebarDropdownOpen(!sidebarDropdownOpen)}
                className="btn btn-secondary btn-sm"
                style={{
                  width: "44px",
                  height: "44px",
                  padding: 0,
                  borderRadius: "var(--radius-md)",
                  display: "grid",
                  placeItems: "center",
                  fontSize: "1.1rem",
                }}
                title={`Workspace: ${currentWorkspace?.name || "Personal"}`}
              >
                {currentWorkspace?.isPersonal ? "👤" : "🏢"}
              </button>

              {sidebarDropdownOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    left: "calc(100% + 8px)",
                    width: "240px",
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-default)",
                    borderRadius: "var(--radius-md)",
                    boxShadow: "var(--shadow-lg)",
                    padding: "8px",
                    zIndex: 1000,
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.7rem",
                      fontWeight: 700,
                      color: "var(--text-muted)",
                      padding: "4px 8px",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                    }}
                  >
                    Select Workspace
                  </div>

                  {workspaces?.map((ws) => (
                    <button
                      key={ws.id}
                      onClick={() => handleSelectWorkspace(ws)}
                      className="btn btn-ghost btn-sm"
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "8px 10px",
                        borderRadius: "var(--radius-sm)",
                        background: ws.id === currentWorkspace?.id ? "rgba(99,102,241,0.15)" : "transparent",
                        color: ws.id === currentWorkspace?.id ? "var(--brand-primary)" : "var(--text-primary)",
                      }}
                    >
                      <span style={{ fontWeight: ws.id === currentWorkspace?.id ? 700 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {ws.name}
                      </span>
                      {ws.id === currentWorkspace?.id && <span style={{ fontSize: "12px" }}>✓</span>}
                    </button>
                  ))}

                  <div style={{ height: "1px", background: "var(--border-subtle)", margin: "4px 0" }} />

                  <button
                    onClick={() => {
                      setSidebarDropdownOpen(false);
                      setCreateModalOpen(true);
                    }}
                    className="btn btn-ghost btn-sm"
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      color: "var(--brand-primary)",
                      justifyContent: "flex-start",
                      padding: "8px 10px",
                    }}
                  >
                    <span>＋</span> Create Team Workspace
                  </button>
                </div>
              )}
            </div>
          )}

          <span className="nav-section-label">Navigation</span>
          <Link
            href="/dashboard"
            className={`nav-item ${isNavActive("/dashboard") ? "active" : ""}`}
          >
            <span className="nav-icon">⬡</span>
            <span className="sidebar-label-text">Overview</span>
            {isCollapsed && <span className="sidebar-tooltip">Overview</span>}
          </Link>
          <Link
            href="/dashboard/projects"
            className={`nav-item ${isNavActive("/dashboard/projects") ? "active" : ""}`}
          >
            <span className="nav-icon">◫</span>
            <span className="sidebar-label-text">Projects</span>
            {isCollapsed && <span className="sidebar-tooltip">Projects</span>}
          </Link>
          <Link
            href="/dashboard/services"
            className={`nav-item ${isNavActive("/dashboard/services") ? "active" : ""}`}
          >
            <span className="nav-icon">⚡</span>
            <span className="sidebar-label-text">Services</span>
            {isCollapsed && <span className="sidebar-tooltip">Services</span>}
          </Link>
          <Link
            href="/dashboard/databases"
            className={`nav-item ${isNavActive("/dashboard/databases") ? "active" : ""}`}
          >
            <span className="nav-icon">🐘</span>
            <span className="sidebar-label-text">Databases</span>
            {isCollapsed && <span className="sidebar-tooltip">Databases</span>}
          </Link>
          <Link
            href="/dashboard/buckets"
            className={`nav-item ${isNavActive("/dashboard/buckets") ? "active" : ""}`}
          >
            <span className="nav-icon">🪣</span>
            <span className="sidebar-label-text">Buckets</span>
            {isCollapsed && <span className="sidebar-tooltip">Buckets</span>}
          </Link>
          <Link
            href="/dashboard/crons"
            className={`nav-item ${isNavActive("/dashboard/crons") ? "active" : ""}`}
          >
            <span className="nav-icon">⏱️</span>
            <span className="sidebar-label-text">Smart Crons</span>
            {isCollapsed && <span className="sidebar-tooltip">Smart Crons</span>}
          </Link>

          <span className="nav-section-label" style={{ marginTop: "12px" }}>
            Modules
          </span>
          <Link href="/dashboard/projects" className={`nav-item ${isNavActive("/dashboard/projects") ? "active" : ""}`}>
            <span className="nav-icon">◫</span>
            <span className="sidebar-label-text">Deployments</span>
            {isCollapsed && <span className="sidebar-tooltip">Deployments</span>}
          </Link>
          <Link href="/dashboard/services" className={`nav-item ${isNavActive("/dashboard/services") ? "active" : ""}`}>
            <span className="nav-icon">⌁</span>
            <span className="sidebar-label-text">Logs &amp; Activity</span>
            {isCollapsed && <span className="sidebar-tooltip">Logs &amp; Activity</span>}
          </Link>
          <Link href="/dashboard/databases" className={`nav-item ${isNavActive("/dashboard/databases") ? "active" : ""}`}>
            <span className="nav-icon">◉</span>
            <span className="sidebar-label-text">Data &amp; Storage</span>
            {isCollapsed && <span className="sidebar-tooltip">Data &amp; Storage</span>}
          </Link>

          <span className="nav-section-label" style={{ marginTop: "12px" }}>
            Workspace
          </span>
          <Link
            href="/dashboard/settings"
            className={`nav-item ${isNavActive("/dashboard/settings") ? "active" : ""}`}
          >
            <span className="nav-icon">⚙</span>
            <span className="sidebar-label-text">Settings</span>
            {isCollapsed && <span className="sidebar-tooltip">Settings</span>}
          </Link>
          <Link
            href="/dashboard/members"
            className={`nav-item ${isNavActive("/dashboard/members") ? "active" : ""}`}
          >
            <span className="nav-icon">◎</span>
            <span className="sidebar-label-text">Members</span>
            {isCollapsed && <span className="sidebar-tooltip">Team Members</span>}
          </Link>
          <Link
            href="/dashboard/usage"
            className={`nav-item ${isNavActive("/dashboard/usage") ? "active" : ""}`}
          >
            <span className="nav-icon">⬟</span>
            <span className="sidebar-label-text">Usage &amp; Billing</span>
            {isCollapsed && <span className="sidebar-tooltip">Usage &amp; Billing</span>}
          </Link>
          <Link
            href="/dashboard/audit"
            className={`nav-item ${isNavActive("/dashboard/audit") ? "active" : ""}`}
          >
            <span className="nav-icon">⊟</span>
            <span className="sidebar-label-text">Audit Log</span>
            {isCollapsed && <span className="sidebar-tooltip">Audit Log</span>}
          </Link>

          {/* Pricing & Comparison Link */}
          <Link href="/pricing" className="nav-item" style={{ marginTop: "4px" }}>
            <span className="nav-icon">💎</span>
            <span className="sidebar-label-text">Plans &amp; Pricing</span>
            <span className="badge badge-active" style={{ fontSize: "0.6rem", marginLeft: "auto", padding: "1px 5px" }}>
              BEST VALUE
            </span>
            {isCollapsed && <span className="sidebar-tooltip">Plans &amp; Pricing (Competitor Comparison)</span>}
          </Link>

          <span className="nav-section-label" style={{ marginTop: "12px" }}>
            Create
          </span>
          <Link href="/dashboard/projects/new" className="nav-item">
            <span className="nav-icon">＋</span>
            <span className="sidebar-label-text">New Project</span>
            {isCollapsed && <span className="sidebar-tooltip">New Project</span>}
          </Link>
          <Link href="/dashboard/services/new" className="nav-item">
            <span className="nav-icon">⚡</span>
            <span className="sidebar-label-text">New Service</span>
            {isCollapsed && <span className="sidebar-tooltip">New Service</span>}
          </Link>
          <Link href="/dashboard/databases/new" className="nav-item">
            <span className="nav-icon">🐘</span>
            <span className="sidebar-label-text">New Database</span>
            {isCollapsed && <span className="sidebar-tooltip">New Database</span>}
          </Link>
          <Link href="/dashboard/buckets/new" className="nav-item">
            <span className="nav-icon">🪣</span>
            <span className="sidebar-label-text">New Bucket</span>
            {isCollapsed && <span className="sidebar-tooltip">New Bucket</span>}
          </Link>

          {/* Quick Invite Teammate Button */}
          <button
            onClick={() => setInviteModalOpen(true)}
            className="nav-item"
            style={{ color: "var(--brand-accent)", marginTop: "4px" }}
          >
            <span className="nav-icon">✉️</span>
            <span className="sidebar-label-text">Invite Teammate</span>
            {isCollapsed && <span className="sidebar-tooltip">Invite Teammate</span>}
          </button>

          {/* Expand / Collapse Sidebar Toggle Button */}
          <div style={{ marginTop: "auto", paddingTop: "12px", borderTop: "1px solid var(--border-subtle)", width: "100%" }}>
            <button
              onClick={toggleCollapse}
              className="btn btn-ghost btn-sm"
              style={{
                width: "100%",
                justifyContent: isCollapsed ? "center" : "space-between",
                color: "var(--text-muted)",
                padding: "8px",
              }}
              title={isCollapsed ? "Expand Sidebar (⌘B)" : "Collapse Sidebar (⌘B)"}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span>{isCollapsed ? "▶" : "◀"}</span>
                {!isCollapsed && <span style={{ fontSize: "0.8125rem" }}>Collapse</span>}
              </div>
              {!isCollapsed && (
                <span style={{ fontSize: "0.7rem", opacity: 0.6, background: "var(--bg-overlay)", padding: "2px 6px", borderRadius: "4px" }}>
                  ⌘B
                </span>
              )}
            </button>
          </div>
        </nav>

        {/* ── Mobile Slide-Over Navigation Drawer ── */}
        <div
          className={`mobile-drawer-overlay ${mobileOpen ? "active" : ""}`}
          onClick={() => setMobileOpen(false)}
        />
        <div
          className={`mobile-drawer ${mobileOpen ? "active" : ""}`}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", paddingBottom: "12px", borderBottom: "1px solid var(--border-subtle)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div className="logo-icon" style={{ width: "28px", height: "28px" }}>
                <Image src="/brand-icon-tight.png" alt="Syncbay" width={20} height={11} />
              </div>
              <strong style={{ fontSize: "1.1rem" }}>Syncbay</strong>
            </div>
            <button
              onClick={() => setMobileOpen(false)}
              className="btn btn-ghost btn-sm"
              style={{ fontSize: "1.2rem", padding: "4px 8px", minWidth: "44px", minHeight: "44px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
              aria-label="Close Navigation"
            >
              ✕
            </button>
          </div>

          <div style={{ marginBottom: "16px" }}>
            <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "6px" }}>
              Current Workspace
            </div>
            {workspaces && workspaces.length > 1 ? (
              <select
                className="input"
                style={{ width: "100%", padding: "6px 10px", fontSize: "0.8125rem" }}
                value={currentWorkspace?.id || ""}
                onChange={(e) => {
                  const targetWs = workspaces.find((w) => w.id === e.target.value);
                  if (targetWs) handleSelectWorkspace(targetWs);
                }}
              >
                {workspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.name} ({ws.isPersonal ? "Personal" : "Team"})
                  </option>
                ))}
              </select>
            ) : (
              <div style={{ fontWeight: 700, color: "var(--text-primary)", fontSize: "0.875rem" }}>
                {currentWorkspace?.name} ({currentWorkspace?.isPersonal ? "Personal" : "Team"})
              </div>
            )}
          </div>

          <span className="nav-section-label">Navigation</span>
          <Link href="/dashboard" className="nav-item" onClick={() => setMobileOpen(false)}>
            <span className="nav-icon">⬡</span> Overview
          </Link>
          <Link href="/dashboard/projects" className="nav-item" onClick={() => setMobileOpen(false)}>
            <span className="nav-icon">◫</span> Projects
          </Link>
          <Link href="/dashboard/services" className="nav-item" onClick={() => setMobileOpen(false)}>
            <span className="nav-icon">⚡</span> Services
          </Link>
          <Link href="/dashboard/databases" className="nav-item" onClick={() => setMobileOpen(false)}>
            <span className="nav-icon">🐘</span> Databases
          </Link>
          <Link href="/dashboard/buckets" className="nav-item" onClick={() => setMobileOpen(false)}>
            <span className="nav-icon">🪣</span> Buckets
          </Link>
          <Link href="/dashboard/crons" className="nav-item" onClick={() => setMobileOpen(false)}>
            <span className="nav-icon">⏱️</span> Smart Crons
          </Link>
          <Link href="/dashboard/shell" className="nav-item" onClick={() => setMobileOpen(false)}>
            <span className="nav-icon">💻</span> Web Shell
          </Link>
          <Link href="/dashboard/studio" className="nav-item" onClick={() => setMobileOpen(false)}>
            <span className="nav-icon">📊</span> Query Studio
          </Link>
          <Link href="/dashboard/settings" className="nav-item" onClick={() => setMobileOpen(false)}>
            <span className="nav-icon">⚙</span> Settings
          </Link>
          <Link href="/dashboard/members" className="nav-item" onClick={() => setMobileOpen(false)}>
            <span className="nav-icon">◎</span> Members
          </Link>
          <Link href="/dashboard/usage" className="nav-item" onClick={() => setMobileOpen(false)}>
            <span className="nav-icon">⬟</span> Usage &amp; Billing
          </Link>
          <Link href="/dashboard/audit" className="nav-item" onClick={() => setMobileOpen(false)}>
            <span className="nav-icon">⊟</span> Audit Log
          </Link>
          <Link href="/pricing" className="nav-item" onClick={() => setMobileOpen(false)}>
            <span className="nav-icon">💎</span> Plans &amp; Pricing
          </Link>

          <span className="nav-section-label" style={{ marginTop: "12px" }}>Create</span>
          <Link href="/dashboard/projects/new" className="nav-item" onClick={() => setMobileOpen(false)}>
            <span className="nav-icon">＋</span> New Project
          </Link>
          <Link href="/dashboard/services/new" className="nav-item" onClick={() => setMobileOpen(false)}>
            <span className="nav-icon">⚡</span> New Service
          </Link>
          <Link href="/dashboard/databases/new" className="nav-item" onClick={() => setMobileOpen(false)}>
            <span className="nav-icon">🐘</span> New Database
          </Link>
          <Link href="/dashboard/buckets/new" className="nav-item" onClick={() => setMobileOpen(false)}>
            <span className="nav-icon">🪣</span> New Bucket
          </Link>

          <div style={{ marginTop: "auto", paddingTop: "16px", borderTop: "1px solid var(--border-subtle)" }}>
            <button
              onClick={() => {
                setMobileOpen(false);
                setInviteModalOpen(true);
              }}
              className="btn btn-primary btn-sm"
              style={{ width: "100%", justifyContent: "center", minHeight: "44px", display: "flex", alignItems: "center" }}
            >
              ✉️ Invite Collaborator
            </button>
          </div>
        </div>

        {/* ── Main Content ── */}
        <main className="main-content">{children}</main>

        {/* Create Workspace Modal */}
        {createModalOpen && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.75)",
              backdropFilter: "blur(4px)",
              display: "grid",
              placeItems: "center",
              zIndex: 9999,
              padding: "20px",
            }}
            onClick={() => setCreateModalOpen(false)}
          >
            <div
              className="card"
              style={{ width: "100%", maxWidth: "440px" }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 style={{ marginBottom: "8px" }}>Create Team Workspace</h3>
              <p style={{ fontSize: "0.875rem", marginBottom: "20px" }}>
                Collaborate on projects, databases, and deployments with your team.
              </p>

              {errorMsg && (
                <div
                  style={{
                    padding: "10px 14px",
                    borderRadius: "var(--radius-md)",
                    background: "rgba(239,68,68,0.15)",
                    color: "#f87171",
                    fontSize: "0.8125rem",
                    marginBottom: "16px",
                    border: "1px solid rgba(239,68,68,0.3)",
                  }}
                >
                  {errorMsg}
                </div>
              )}

              <form onSubmit={handleCreateWorkspace} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <div className="field">
                  <label>Workspace Name</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="Acme Corp"
                    value={newWsName}
                    onChange={(e) => {
                      setNewWsName(e.target.value);
                      if (!newWsSlug) {
                        setNewWsSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "-"));
                      }
                    }}
                    required
                  />
                </div>

                <div className="field">
                  <label>Workspace Slug (URL identifier)</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="acme-corp"
                    value={newWsSlug}
                    onChange={(e) => setNewWsSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                    required
                  />
                  <span className="field-hint">
                    Your workspace will be accessible at /dashboard/{newWsSlug || "slug"}
                  </span>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "8px" }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setCreateModalOpen(false)}
                    disabled={creatingWs}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={creatingWs || !newWsName || !newWsSlug}
                  >
                    {creatingWs ? "Creating..." : "Create Workspace"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Global Invite Teammate Modal */}
        {inviteModalOpen && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.75)",
              backdropFilter: "blur(4px)",
              display: "grid",
              placeItems: "center",
              zIndex: 9999,
              padding: "20px",
            }}
            onClick={() => setInviteModalOpen(false)}
          >
            <div
              className="card fade-in"
              style={{ width: "100%", maxWidth: "480px" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <h3>Invite to {currentWorkspace?.name}</h3>
                <button
                  onClick={() => setInviteModalOpen(false)}
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "1.2rem", padding: "2px 8px" }}
                >
                  ✕
                </button>
              </div>

              <p style={{ fontSize: "0.875rem", marginBottom: "20px" }}>
                Generate an invitation link with granular RBAC permissions.
              </p>

              {inviteError && (
                <div
                  style={{
                    padding: "10px 14px",
                    borderRadius: "var(--radius-md)",
                    background: "rgba(239,68,68,0.15)",
                    border: "1px solid rgba(239,68,68,0.3)",
                    color: "#f87171",
                    fontSize: "0.8125rem",
                    marginBottom: "16px",
                  }}
                >
                  {inviteError}
                </div>
              )}

              {inviteResult ? (
                <div style={{ marginBottom: "20px" }}>
                  <div
                    style={{
                      padding: "12px",
                      background: "rgba(34,197,94,0.12)",
                      border: "1px solid rgba(34,197,94,0.3)",
                      borderRadius: "var(--radius-md)",
                      color: "#4ade80",
                      fontSize: "0.85rem",
                      marginBottom: "12px",
                    }}
                  >
                    ✔ Invitation generated successfully! Share this link with your teammate:
                  </div>

                  <div
                    style={{
                      padding: "10px",
                      background: "var(--bg-overlay)",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--border-default)",
                      fontSize: "0.8rem",
                      wordBreak: "break-all",
                      marginBottom: "12px",
                      fontFamily: "monospace",
                    }}
                  >
                    {inviteResult.link}
                  </div>

                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(inviteResult.link);
                        alert("Invitation link copied to clipboard!");
                      }}
                      className="btn btn-primary btn-sm"
                    >
                      Copy Invite Link
                    </button>
                    <button
                      onClick={() => setInviteResult(null)}
                      className="btn btn-secondary btn-sm"
                    >
                      Invite Another
                    </button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleSendInvite} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <div className="field">
                    <label>Collaborator Email</label>
                    <input
                      type="email"
                      className="input"
                      placeholder="engineer@company.com"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      required
                    />
                  </div>

                  <div className="grid-2" style={{ gap: "12px" }}>
                    <div className="field">
                      <label>Assigned Role</label>
                      <select
                        className="input"
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value as "ADMIN" | "MEMBER" | "VIEWER")}
                      >
                        <option value="ADMIN">ADMIN (Full Management)</option>
                        <option value="MEMBER">MEMBER (Deploy &amp; Manage)</option>
                        <option value="VIEWER">VIEWER (Read-only)</option>
                      </select>
                    </div>

                    <div className="field">
                      <label>Expires In</label>
                      <select
                        className="input"
                        value={inviteDays}
                        onChange={(e) => setInviteDays(parseInt(e.target.value, 10))}
                      >
                        <option value={1}>24 Hours</option>
                        <option value={7}>7 Days</option>
                        <option value={30}>30 Days</option>
                      </select>
                    </div>
                  </div>

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "8px" }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setInviteModalOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={inviteMutation.isPending || !inviteEmail.trim()}
                    >
                      {inviteMutation.isPending ? "Generating..." : "Generate Invite Link"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        )}
      </div>
    </DashboardContext.Provider>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc-client";
import { useDashboard } from "../dashboard-shell";

export default function DatabasesPage() {
  const dashboard = useDashboard();
  const { data: workspaces, isLoading: wsLoading } = trpc.workspace.list.useQuery();
  const [selectedWsId, setSelectedWsId] = useState<string>("");

  const activeWorkspace =
    workspaces?.find((w) => w.id === (selectedWsId || dashboard?.currentWorkspace?.id)) ||
    dashboard?.currentWorkspace ||
    workspaces?.[0];

  const workspaceId = activeWorkspace?.id;

  const {
    data: databases,
    isLoading: dbLoading,
    refetch: refetchDatabases,
  } = trpc.database.list.useQuery(
    { workspaceId },
    { enabled: !!workspaceId }
  );

  const currentMember = activeWorkspace?.members?.find((m: any) => m.userId === dashboard?.user?.id);
  const canDeleteDb = currentMember?.role === "OWNER" || currentMember?.role === "ADMIN" || activeWorkspace?.isPersonal;

  const [providerFilter, setProviderFilter] = useState<string>("ALL");
  const [revealedPasswords, setRevealedPasswords] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [activeSnippetTab, setActiveSnippetTab] = useState<string>("postgres");

  const deleteMutation = trpc.database.delete.useMutation();

  const togglePassword = (id: string) => {
    setRevealedPasswords((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDelete = async (databaseId: string, name: string) => {
    if (!confirm(`Are you sure you want to delete ${name}? All stored tables and data will be permanently wiped.`)) {
      return;
    }
    setDeletingId(databaseId);
    try {
      await deleteMutation.mutateAsync({ databaseId, confirmName: name });
      await refetchDatabases();
    } catch (err: any) {
      alert(err.message || "Failed to delete database");
    } finally {
      setDeletingId(null);
    }
  };

  const filteredDatabases = databases?.filter((db) => {
    if (providerFilter === "ALL") return true;
    return db.provider === providerFilter;
  });

  return (
    <div className="fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Managed Databases</h1>
          <p className="page-subtitle">
            Zero-config PostgreSQL and Redis instances running alongside your edge workloads.
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          <Link href="/dashboard/databases/new" className="btn btn-primary">
            ＋ New Database
          </Link>
        </div>
      </div>

      {/* Workspace Switcher Filter */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
          marginBottom: "24px",
          borderBottom: "1px solid var(--border-subtle)",
          paddingBottom: "16px",
        }}
      >
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {workspaces?.map((ws) => (
            <button
              key={ws.id}
              onClick={() => setSelectedWsId(ws.id)}
              className={`btn btn-sm ${
                (selectedWsId || dashboard?.currentWorkspace?.id) === ws.id
                  ? "btn-secondary"
                  : "btn-ghost"
              }`}
              style={
                (selectedWsId || dashboard?.currentWorkspace?.id) === ws.id
                  ? { borderColor: "var(--brand-primary)" }
                  : {}
              }
            >
              <span>{ws.isPersonal ? "👤" : "🏢"}</span> {ws.name}
            </button>
          ))}
        </div>

        {/* Provider Filters */}
        <div style={{ display: "flex", gap: "6px" }}>
          {["ALL", "POSTGRES", "REDIS", "MYSQL"].map((p) => (
            <button
              key={p}
              onClick={() => setProviderFilter(p)}
              className={`btn btn-sm ${providerFilter === p ? "btn-secondary" : "btn-ghost"}`}
              style={{
                fontSize: "0.75rem",
                borderColor: providerFilter === p ? "var(--brand-primary)" : "transparent",
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {dbLoading || wsLoading ? (
        <div style={{ textAlign: "center", padding: "64px" }}>
          <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }} />
          <p style={{ color: "var(--text-muted)" }}>Loading database clusters...</p>
        </div>
      ) : !filteredDatabases || filteredDatabases.length === 0 ? (
        <div className="empty-state card" style={{ padding: "48px 24px", textAlign: "center" }}>
          <div className="empty-icon" style={{ fontSize: "42px", marginBottom: "12px" }}>
            🐘
          </div>
          <h3 style={{ fontSize: "1.25rem", marginBottom: "8px" }}>No Managed Databases</h3>
          <p style={{ color: "var(--text-secondary)", maxWidth: "480px", margin: "0 auto 20px" }}>
            Provision a high-performance PostgreSQL or Redis instance with automatic daily backups,
            0ms local latency, and connection string injection into your microservices.
          </p>
          <Link href="/dashboard/databases/new" className="btn btn-primary">
            Provision Database Cluster
          </Link>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {filteredDatabases.map((db) => {
            const isRevealed = !!revealedPasswords[db.id];
            const rawUrl = db.connectionUrl || "";
            const displayUrl = isRevealed
              ? rawUrl
              : rawUrl.replace(/:([^:@]+)@/, ":••••••••@");

            return (
              <div
                key={db.id}
                className="card"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "16px",
                  padding: "20px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                    gap: "12px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <div
                      style={{
                        width: "44px",
                        height: "44px",
                        borderRadius: "var(--radius-md)",
                        background:
                          db.provider === "POSTGRES"
                            ? "rgba(59,130,246,0.15)"
                            : db.provider === "REDIS"
                            ? "rgba(239,68,68,0.15)"
                            : "rgba(245,158,11,0.15)",
                        color:
                          db.provider === "POSTGRES"
                            ? "#60a5fa"
                            : db.provider === "REDIS"
                            ? "#f87171"
                            : "#fbbf24",
                        display: "grid",
                        placeItems: "center",
                        fontSize: "20px",
                        fontWeight: 700,
                      }}
                    >
                      {db.provider === "POSTGRES" ? "🐘" : db.provider === "REDIS" ? "⚡" : "🐬"}
                    </div>

                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <h3 style={{ fontSize: "1.1rem", fontWeight: 700 }}>{db.name}</h3>
                        <span className="badge badge-active" style={{ fontSize: "0.7rem" }}>
                          ACTIVE
                        </span>
                        <span className="badge badge-secondary" style={{ fontSize: "0.7rem" }}>
                          {db.provider}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: "0.8rem",
                          color: "var(--text-muted)",
                          display: "flex",
                          gap: "12px",
                          marginTop: "2px",
                        }}
                      >
                        <span>Project: {db.environment?.project?.name || "Global"}</span>
                        <span>•</span>
                        <span>Region: {db.region || "us-east-1"}</span>
                        <span>•</span>
                        <span>Port: {db.credentials?.port || 5432}</span>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    {db.environment?.project?.id && (
                      <Link
                        href={`/dashboard/projects/${db.environment.project.id}?tab=databases`}
                        className="btn btn-secondary btn-sm"
                        style={{ fontSize: "0.75rem" }}
                      >
                        📊 Query Studio
                      </Link>
                    )}
                    {canDeleteDb && (
                      <button
                        onClick={() => handleDelete(db.id, db.name)}
                        disabled={deletingId === db.id}
                        className="btn btn-danger btn-sm"
                        style={{ fontSize: "0.75rem" }}
                      >
                        {deletingId === db.id ? "Wiping..." : "Delete"}
                      </button>
                    )}
                  </div>
                </div>

                {/* Connection URL Box */}
                <div
                  style={{
                    background: "var(--bg-overlay)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-sm)",
                    padding: "10px 14px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "12px",
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: "0.8125rem",
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {displayUrl}
                  </span>

                  <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                    <button
                      onClick={() => togglePassword(db.id)}
                      className="btn btn-ghost btn-sm"
                      style={{ fontSize: "0.75rem", padding: "3px 8px" }}
                    >
                      {isRevealed ? "Hide" : "Show"}
                    </button>
                    <button
                      onClick={() => copyToClipboard(db.connectionUrl, db.id)}
                      className="btn btn-secondary btn-sm"
                      style={{ fontSize: "0.75rem", padding: "3px 10px" }}
                    >
                      {copiedId === db.id ? "✓ Copied" : "Copy URI"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Code Connection Snippets Card */}
      <div className="card" style={{ marginTop: "32px", padding: "24px" }}>
        <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "8px" }}>
          ⚡ Connect From Your Service Code
        </h3>
        <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", marginBottom: "16px" }}>
          Reference variables automatically resolve inside your container deployments using{" "}
          <code style={{ color: "var(--brand-accent)" }}>${`{{ Postgres.URL }}`}</code>.
        </p>

        <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
          {[
            { id: "postgres", label: "Node.js (pg / pgvector)" },
            { id: "prisma", label: "Prisma ORM" },
            { id: "python", label: "Python (asyncpg)" },
            { id: "go", label: "Go (pgx)" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveSnippetTab(tab.id)}
              className={`btn btn-sm ${
                activeSnippetTab === tab.id ? "btn-secondary" : "btn-ghost"
              }`}
              style={{ fontSize: "0.75rem" }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <pre
          style={{
            background: "#080812",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-sm)",
            padding: "16px",
            fontSize: "0.8rem",
            color: "#38bdf8",
            overflowX: "auto",
            margin: 0,
          }}
        >
          {activeSnippetTab === "postgres" &&
            `import { Pool } from 'pg';\n\nconst pool = new Pool({\n  connectionString: process.env.DATABASE_URL,\n  ssl: { rejectUnauthorized: false },\n});\n\nconst res = await pool.query('SELECT NOW() as current_time');\nconsole.log('Connected to Syncbay Postgres:', res.rows[0]);`}
          {activeSnippetTab === "prisma" &&
            `// schema.prisma\ndatasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\ngenerator client {\n  provider = "prisma-client-js"\n}`}
          {activeSnippetTab === "python" &&
            `import asyncpg\nimport os\n\nasync def connect():\n    conn = await asyncpg.connect(os.environ["DATABASE_URL"])\n    val = await conn.fetchval("SELECT 1")\n    print("Postgres OK:", val)\n    await conn.close()`}
          {activeSnippetTab === "go" &&
            `package main\n\nimport (\n    "context"\n    "os"\n    "github.com/jackc/pgx/v5"\n)\n\nfunc main() {\n    conn, _ := pgx.Connect(context.Background(), os.Getenv("DATABASE_URL"))\n    defer conn.Close(context.Background())\n}`}
        </pre>
      </div>
    </div>
  );
}

"use client";

import { Suspense, useEffect } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { BackButton } from "@/components/ui/back-button";
import { DatabaseBrowser } from "@/components/data/database-browser";
import { BucketBrowser } from "@/components/data/bucket-browser";
import { VolumeBrowser } from "@/components/data/volume-browser";
import { errorText } from "@/components/data/format";
import styles from "@/components/data/data.module.css";

/** `?focus=db:<id>` | `bucket:<id>` | `volume:<id>` → the element id rendered for that resource. */
function focusTarget(focus: string | null): { kind: "db" | "bucket" | "volume"; id: string } | null {
  const m = focus?.match(/^(db|bucket|volume):([A-Za-z0-9_-]{1,64})$/);
  return m ? { kind: m[1] as "db" | "bucket" | "volume", id: m[2] } : null;
}

function DataViewContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const focusParam = searchParams.get("focus");
  const focus = focusTarget(focusParam);
  const inventory = trpc.data.inventory.useQuery({ projectId }, { retry: false, refetchOnWindowFocus: false });
  const data = inventory.data;

  // Bring the focused resource into view once it has rendered.
  useEffect(() => {
    const target = focusTarget(focusParam);
    if (!data || !target) return;
    document.getElementById(`${target.kind}-${target.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [data, focusParam]);

  if (inventory.isLoading) {
    return (
      <div style={{ textAlign: "center", padding: "64px" }}>
        <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }} />
        <p style={{ color: "var(--text-muted)" }}>Loading data sources…</p>
      </div>
    );
  }
  if (inventory.error || !data) {
    return (
      <div className="card" style={{ padding: "32px", textAlign: "center" }}>
        <h1 className="page-title">Data unavailable</h1>
        <p style={{ marginTop: "8px" }}>{inventory.error ? errorText(inventory.error) : "Project not found"}</p>
        <Link href="/dashboard/projects" className="btn btn-secondary" style={{ marginTop: "16px" }}>
          Back to projects
        </Link>
      </div>
    );
  }

  const canQuery = Boolean(data.myRole && data.myRole !== "VIEWER");
  const isFocused = (kind: "db" | "bucket" | "volume", id: string) => focus?.kind === kind && focus.id === id;
  const databaseCount = data.environments.reduce((n, e) => n + e.databases.length, 0);
  const volumeCount = data.environments.reduce((n, e) => n + e.services.reduce((m, s) => m + s.volumes.length, 0), 0);

  return (
    <div className={`fade-in ${styles.page}`} style={{ maxWidth: "1100px", margin: "0 auto" }}>
      <header>
        <BackButton fallbackUrl={`/dashboard/projects/${data.id}`} label="Back to project" />
        <div className={styles.header}>
          <div>
            <h1 className="page-title">
              <span aria-hidden="true">🗂 </span>Data · {data.name}
            </h1>
            <p className={styles.subtle}>
              Databases, buckets and volumes of this project, read-only. {databaseCount} database{databaseCount === 1 ? "" : "s"}, {data.buckets.length} bucket
              {data.buckets.length === 1 ? "" : "s"}, {volumeCount} volume{volumeCount === 1 ? "" : "s"}.
            </p>
          </div>
          <div className={styles.actions}>
            <Link href={`/dashboard/projects/${data.id}?tab=query-studio`} className="btn btn-secondary btn-sm">
              📊 Query Studio
            </Link>
            <Link href={`/dashboard/projects/${data.id}`} className="btn btn-ghost btn-sm">
              Project console
            </Link>
          </div>
        </div>
      </header>

      {(!data.runnerConfigured || !data.storageConfigured || !canQuery) && (
        <div className={`${styles.banner} ${styles.bannerWarn}`} role="note">
          {!data.runnerConfigured && <p>No runner is configured on Syncbay (RUNNER_URL): volumes cannot be browsed and runner health checks are skipped.</p>}
          {!data.storageConfigured && <p>Object storage is not configured (R2 keys missing): bucket contents cannot be listed.</p>}
          {!canQuery && <p>You are a viewer in this workspace: you can see schemas and file lists, but not rows or file contents.</p>}
        </div>
      )}

      {data.environments.map((env) => {
        const services = env.services.filter((s) => s.volumes.length > 0);
        return (
          <section key={env.id} className={styles.envSection} aria-labelledby={`env-${env.id}`}>
            <h2 id={`env-${env.id}`} className={styles.envTitle}>
              {env.name}
              {env.isDefault && <span className="badge badge-active">default</span>}
            </h2>

            <h3 className={styles.groupTitle}>Databases</h3>
            {env.databases.length === 0 ? (
              <div className={`card ${styles.empty}`}>
                No databases in {env.name}.{" "}
                <Link href={`/dashboard/databases/new?projectId=${data.id}`} style={{ color: "var(--brand-primary)" }}>
                  Attach one
                </Link>
              </div>
            ) : (
              env.databases.map((db) => <DatabaseBrowser key={db.id} db={db} canQuery={canQuery} focused={isFocused("db", db.id)} />)
            )}

            <h3 className={styles.groupTitle}>Volumes</h3>
            {services.length === 0 ? (
              <div className={`card ${styles.empty}`}>No service in {env.name} mounts a volume.</div>
            ) : (
              services.map((svc) => (
                <div key={svc.id} className={styles.serviceBlock}>
                  <p className={styles.serviceTitle}>
                    <span aria-hidden="true">⚙️</span> {svc.name}
                  </p>
                  {svc.volumes.map((vol) => (
                    <VolumeBrowser
                      key={vol.id}
                      volume={vol}
                      serviceName={svc.name}
                      runnerConfigured={data.runnerConfigured}
                      canRead={canQuery}
                      focused={isFocused("volume", vol.id)}
                    />
                  ))}
                </div>
              ))
            )}
          </section>
        );
      })}

      <section className={styles.envSection} aria-labelledby="buckets-title">
        <h2 id="buckets-title" className={styles.envTitle}>
          Buckets
          {data.storageEndpoint && <span className={styles.subtle}>{data.storageEndpoint}</span>}
        </h2>
        {data.buckets.length === 0 ? (
          <div className={`card ${styles.empty}`}>
            No buckets in this project.{" "}
            <Link href={`/dashboard/buckets/new?projectId=${data.id}`} style={{ color: "var(--brand-primary)" }}>
              Create one
            </Link>
          </div>
        ) : (
          data.buckets.map((b) => <BucketBrowser key={b.id} bucket={b} storageConfigured={data.storageConfigured} focused={isFocused("bucket", b.id)} />)
        )}
      </section>
    </div>
  );
}

export default function ProjectDataPage() {
  return (
    <Suspense
      fallback={
        <div style={{ textAlign: "center", padding: "64px" }}>
          <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }} />
          <p style={{ color: "var(--text-muted)" }}>Loading data sources…</p>
        </div>
      }
    >
      <DataViewContent />
    </Suspense>
  );
}

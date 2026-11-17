"use client";

import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { trpc } from "@/lib/trpc-client";
import type { AppRouter } from "@/server/root";
import { buildRedisPreviewCommand, buildTablePreviewQuery, PREVIEW_ROW_LIMIT } from "@/lib/query-studio/preview";
import styles from "./data.module.css";
import { ConnectionResult, ConnectionTest } from "./connection-test";
import { ResultTable } from "./result-table";
import { errorText, formatDate } from "./format";

type Inventory = inferRouterOutputs<AppRouter>["data"]["inventory"];
type InventoryDatabase = Inventory["environments"][number]["databases"][number];
type TableInfo = inferRouterOutputs<AppRouter>["queryStudio"]["getSchema"]["tables"][number];

const PROVIDER_ICON: Record<string, string> = { POSTGRES: "🐘", REDIS: "🔴", MYSQL: "🐬" };
const STATUS_BADGE: Record<string, string> = {
  ACTIVE: "badge-active",
  PROVISIONING: "badge-building",
  UNHEALTHY: "badge-failed",
  FAILED: "badge-failed",
  DELETING: "badge-queued",
};

export function DatabaseBrowser({ db, canQuery, focused }: { db: InventoryDatabase; canQuery: boolean; focused: boolean }) {
  const [open, setOpen] = useState(focused);
  const [selected, setSelected] = useState<string | null>(null);
  const check = trpc.database.checkConnection.useMutation();
  const browsable = db.status === "ACTIVE" && !db.simulated;
  const schema = trpc.queryStudio.getSchema.useQuery({ databaseId: db.id }, { enabled: open && browsable, retry: false, refetchOnWindowFocus: false });
  const preview = trpc.queryStudio.execute.useMutation();
  const isRedis = db.provider === "REDIS";
  const panelId = `db-panel-${db.id}`;

  const openTable = (table: TableInfo) => {
    setSelected(table.tableName);
    const query = isRedis
      ? buildRedisPreviewCommand(table.tableName, table.columns[0]?.type ?? "string")
      : buildTablePreviewQuery(db.provider === "MYSQL" ? "MYSQL" : "POSTGRES", table, PREVIEW_ROW_LIMIT);
    preview.mutate({ databaseId: db.id, query, mode: "read", safeMode: true });
  };

  return (
    <section id={`db-${db.id}`} className={`card ${styles.resource} ${focused ? styles.resourceFocused : ""}`} aria-labelledby={`db-title-${db.id}`}>
      <div className={styles.resourceHead}>
        <div>
          <h4 id={`db-title-${db.id}`} className={styles.resourceName}>
            <span aria-hidden="true">{PROVIDER_ICON[db.provider] ?? "🗄️"}</span>
            {db.name}
            <span className={`badge ${STATUS_BADGE[db.status] ?? "badge-queued"}`}>{db.status}</span>
            <span className="badge badge-queued">{db.provider}</span>
            {db.simulated && <span className="badge badge-queued">simulated</span>}
          </h4>
          <div className={styles.meta}>
            <span>
              URL: <code>{db.maskedUrl || "—"}</code>
            </span>
            <span>Region: {db.region}</span>
            <span>{db.runnerManaged ? "On a Syncbay runner" : db.simulated ? "No server (simulated)" : "External / unmanaged"}</span>
            <span>Last health: {formatDate(db.lastHealthAt)}</span>
          </div>
        </div>
        <div className={styles.actions}>
          <ConnectionTest onTest={() => check.mutate({ databaseId: db.id })} pending={check.isPending} result={check.data} resourceName={db.name} />
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)} disabled={!browsable}>
            {open ? "Hide data" : isRedis ? "Browse keys" : "Browse tables"}
          </button>
        </div>
      </div>

      <ConnectionResult result={check.data} error={check.error} />

      {open && browsable && (
        <div id={panelId} className={styles.browser}>
          <div>
            <p className={styles.groupTitle}>{isRedis ? "Key sample" : "Tables"}</p>
            {schema.isLoading && <p className={styles.muted}>Introspecting…</p>}
            {schema.error && <p className={styles.error}>{errorText(schema.error)}</p>}
            {schema.data && schema.data.tables.length === 0 && <p className={styles.muted}>{isRedis ? "No keys." : "No tables."}</p>}
            {schema.data && schema.data.tables.length > 0 && (
              <ul className={styles.list} aria-label={isRedis ? `Keys in ${db.name}` : `Tables in ${db.name}`}>
                {schema.data.tables.map((t) => (
                  <li key={t.tableName}>
                    <button
                      type="button"
                      className={`${styles.listButton} ${selected === t.tableName ? styles.listButtonActive : ""}`}
                      aria-pressed={selected === t.tableName}
                      onClick={() => openTable(t)}
                      disabled={!canQuery}
                      title={canQuery ? undefined : "Viewers cannot read rows"}
                    >
                      <span className={styles.itemName}>{t.tableName}</span>
                      <span className={styles.itemMeta}>
                        {isRedis ? `${t.columns[0]?.type ?? "?"} · ${t.rowCountEstimate}` : `~${t.rowCountEstimate.toLocaleString()} rows`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className={styles.panel} aria-live="polite">
            {!canQuery && <p className={styles.muted}>Viewers can see the schema but not rows.</p>}
            {!selected && canQuery && <p className={styles.muted}>Select a {isRedis ? "key" : "table"} to see {isRedis ? "its value" : `its first ${PREVIEW_ROW_LIMIT} rows`} (read-only).</p>}
            {selected && preview.isPending && <p className={styles.muted}>Loading {selected}…</p>}
            {selected && preview.error && <p className={styles.error}>{errorText(preview.error)}</p>}
            {selected && preview.data && !preview.isPending && (
              <>
                <p className={styles.muted}>
                  <strong>{selected}</strong> · {preview.data.rowCount} row{preview.data.rowCount === 1 ? "" : "s"} · {preview.data.durationMs} ms · read-only
                </p>
                <ResultTable caption={`Rows of ${selected}`} columns={preview.data.columns} rows={preview.data.rows} />
              </>
            )}
          </div>
        </div>
      )}
      {!browsable && (
        <p className={styles.muted}>
          {db.simulated ? "This simulated instance has no server, so there is no data to show." : `Browsing is available once the database is ACTIVE (now ${db.status}).`}
        </p>
      )}
    </section>
  );
}

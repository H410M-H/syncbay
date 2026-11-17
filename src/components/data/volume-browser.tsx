"use client";

import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { trpc } from "@/lib/trpc-client";
import type { AppRouter } from "@/server/root";
import styles from "./data.module.css";
import { ConnectionResult, ConnectionTest } from "./connection-test";
import { Breadcrumbs } from "./breadcrumbs";
import { errorText, formatBytes, formatDate } from "./format";

type InventoryVolume = inferRouterOutputs<AppRouter>["data"]["inventory"]["environments"][number]["services"][number]["volumes"][number];

const ENTRY_ICON: Record<string, string> = { dir: "📁", file: "📄", symlink: "🔗", other: "❔" };

/**
 * Read-only file browser of a service volume, served by the runner that hosts it
 * (`volume.listFiles` / `volume.readFile`). Text files show up to 64 KB; binary files show
 * size and type only. Symlinks are listed but never followed. Viewers see listings only.
 */
export function VolumeBrowser({
  volume,
  serviceName,
  runnerConfigured,
  canRead,
  focused,
}: {
  volume: InventoryVolume;
  serviceName: string;
  runnerConfigured: boolean;
  canRead: boolean;
  focused: boolean;
}) {
  const [open, setOpen] = useState(focused);
  const [dir, setDir] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const check = trpc.volume.checkConnection.useMutation();
  const listing = trpc.volume.listFiles.useQuery(
    { volumeId: volume.id, path: dir },
    { enabled: open && runnerConfigured, retry: false, refetchOnWindowFocus: false }
  );
  const preview = trpc.volume.readFile.useQuery(
    { volumeId: volume.id, path: file ?? "" },
    { enabled: open && runnerConfigured && canRead && Boolean(file), retry: false, refetchOnWindowFocus: false }
  );
  const segments = dir.split("/").filter(Boolean);
  const panelId = `volume-panel-${volume.id}`;

  const enter = (name: string) => {
    setDir(dir ? `${dir}/${name}` : name);
    setFile(null);
  };

  return (
    <section id={`volume-${volume.id}`} className={`card ${styles.resource} ${focused ? styles.resourceFocused : ""}`} aria-labelledby={`volume-title-${volume.id}`}>
      <div className={styles.resourceHead}>
        <div>
          <h4 id={`volume-title-${volume.id}`} className={styles.resourceName}>
            <span aria-hidden="true">💾</span>
            {volume.name}
            <span className="badge badge-queued">{volume.sizeGb} GB</span>
          </h4>
          <div className={styles.meta}>
            <span>
              Mounted at <code>{volume.mountPath}</code> in {serviceName}
            </span>
            <span>Created {formatDate(volume.createdAt)}</span>
          </div>
        </div>
        <div className={styles.actions}>
          <ConnectionTest onTest={() => check.mutate({ volumeId: volume.id })} pending={check.isPending} result={check.data} resourceName={volume.name} />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
            disabled={!runnerConfigured}
          >
            {open ? "Hide files" : "Browse files"}
          </button>
        </div>
      </div>

      <ConnectionResult result={check.data} error={check.error} />

      {!runnerConfigured && <p className={styles.muted}>Volumes live on a runner, and none is configured on Syncbay (RUNNER_URL), so files cannot be listed.</p>}

      {open && runnerConfigured && (
        <div id={panelId} className={styles.panel}>
          <Breadcrumbs
            rootLabel={volume.mountPath || volume.name}
            segments={segments}
            onNavigate={(depth) => {
              setDir(segments.slice(0, depth).join("/"));
              setFile(null);
            }}
            label={`Location in volume ${volume.name}`}
          />
          <div className={styles.browser}>
            <div>
              {listing.isLoading && <p className={styles.muted}>Listing files…</p>}
              {listing.error && <p className={styles.error}>{errorText(listing.error)}</p>}
              {listing.data && listing.data.entries.length === 0 && <p className={styles.muted}>This folder is empty.</p>}
              {listing.data && listing.data.entries.length > 0 && (
                <ul className={styles.list} aria-label={`Files in /${dir}`}>
                  {listing.data.entries.map((entry) => {
                    const icon = ENTRY_ICON[entry.type] ?? ENTRY_ICON.other;
                    const fullPath = dir ? `${dir}/${entry.name}` : entry.name;
                    const meta = entry.type === "dir" ? "folder" : entry.type === "symlink" ? "symlink (not followed)" : formatBytes(entry.size);
                    if (entry.type === "dir") {
                      return (
                        <li key={entry.name}>
                          <button type="button" className={styles.listButton} onClick={() => enter(entry.name)} aria-label={`Open folder ${entry.name}`}>
                            <span className={styles.itemName}>
                              <span aria-hidden="true">{icon}</span> {entry.name}
                            </span>
                            <span className={styles.itemMeta}>{meta}</span>
                          </button>
                        </li>
                      );
                    }
                    if (entry.type === "file") {
                      return (
                        <li key={entry.name}>
                          <button
                            type="button"
                            className={`${styles.listButton} ${file === fullPath ? styles.listButtonActive : ""}`}
                            aria-pressed={file === fullPath}
                            onClick={() => setFile(fullPath)}
                            disabled={!canRead}
                            title={canRead ? undefined : "Viewers cannot read file contents"}
                          >
                            <span className={styles.itemName}>
                              <span aria-hidden="true">{icon}</span> {entry.name}
                            </span>
                            <span className={styles.itemMeta}>{meta}</span>
                          </button>
                        </li>
                      );
                    }
                    return (
                      <li key={entry.name} className={styles.listButton}>
                        <span className={styles.itemName}>
                          <span aria-hidden="true">{icon}</span> {entry.name}
                        </span>
                        <span className={styles.itemMeta}>{meta}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {listing.data?.truncated && <p className={styles.subtle}>Showing the first {listing.data.entries.length} entries.</p>}
            </div>

            <div className={styles.panel} aria-live="polite">
              {!canRead && <p className={styles.muted}>Viewers can list files but not open them.</p>}
              {canRead && !file && <p className={styles.muted}>Select a file to preview it (text up to 64 KB, read-only).</p>}
              {file && preview.isLoading && <p className={styles.muted}>Reading {file}…</p>}
              {file && preview.error && <p className={styles.error}>{errorText(preview.error)}</p>}
              {file && preview.data && preview.data.kind === "text" && (
                <>
                  <p className={styles.muted}>
                    <strong>/{preview.data.path}</strong> · {formatBytes(preview.data.size)} · modified {formatDate(preview.data.mtime)}
                    {preview.data.truncated ? " · showing the first 64 KB" : ""}
                  </p>
                  <pre className={styles.preview} tabIndex={0} aria-label={`Contents of ${preview.data.path}`}>
                    {preview.data.text || "(empty file)"}
                  </pre>
                </>
              )}
              {file && preview.data && preview.data.kind === "binary" && (
                <div className={styles.result}>
                  <span>
                    <strong>/{preview.data.path}</strong> is a binary file.
                  </span>
                  <span>
                    Size {formatBytes(preview.data.size)} · type {preview.data.mimeType} · modified {formatDate(preview.data.mtime)}
                  </span>
                  <span className={styles.hint}>Binary files are not shown here.</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

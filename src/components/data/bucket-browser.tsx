"use client";

import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { trpc } from "@/lib/trpc-client";
import type { AppRouter } from "@/server/root";
import styles from "./data.module.css";
import { ConnectionResult, ConnectionTest } from "./connection-test";
import { Breadcrumbs } from "./breadcrumbs";
import { errorText, formatBytes, formatDate } from "./format";

type InventoryBucket = inferRouterOutputs<AppRouter>["data"]["inventory"]["buckets"][number];

const PAGE_SIZE = 100;

/** Prefix ("a/b/") → breadcrumb segments ["a", "b"]. */
function prefixSegments(prefix: string): string[] {
  return prefix.split("/").filter(Boolean);
}

/**
 * Object list of one bucket, grouped into folders by "/" (S3 CommonPrefixes), with breadcrumbs,
 * "Load more" pagination and downloads through a short-lived presigned GET URL.
 */
export function BucketBrowser({ bucket, storageConfigured, focused }: { bucket: InventoryBucket; storageConfigured: boolean; focused: boolean }) {
  const [open, setOpen] = useState(focused);
  const [prefix, setPrefix] = useState("");
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const check = trpc.bucket.checkConnection.useMutation();
  const presign = trpc.bucket.generatePresignedUrl.useMutation();
  const listing = trpc.bucket.listObjects.useInfiniteQuery(
    { bucketId: bucket.id, prefix: prefix || undefined, delimiter: "/", limit: PAGE_SIZE },
    {
      enabled: open && storageConfigured,
      getNextPageParam: (last) => last.nextContinuationToken ?? undefined,
      retry: false,
      refetchOnWindowFocus: false,
    }
  );
  const panelId = `bucket-panel-${bucket.id}`;
  const pages = listing.data?.pages ?? [];
  const folders = pages.flatMap((p) => p.prefixes);
  const objects = pages.flatMap((p) => p.objects).filter((o) => o.key !== prefix); // hide the "folder marker" object
  const segments = prefixSegments(prefix);

  const download = async (key: string) => {
    setDownloadError(null);
    try {
      const res = await presign.mutateAsync({ bucketId: bucket.id, key, operation: "get", expiresInSeconds: 300 });
      window.open(res.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setDownloadError(errorText(err));
    }
  };

  return (
    <section id={`bucket-${bucket.id}`} className={`card ${styles.resource} ${focused ? styles.resourceFocused : ""}`} aria-labelledby={`bucket-title-${bucket.id}`}>
      <div className={styles.resourceHead}>
        <div>
          <h4 id={`bucket-title-${bucket.id}`} className={styles.resourceName}>
            <span aria-hidden="true">🪣</span>
            {bucket.name}
            <span className="badge badge-queued">private</span>
          </h4>
          <div className={styles.meta}>
            <span>
              Bucket: <code>{bucket.r2BucketRef}</code>
            </span>
            <span>Created {formatDate(bucket.createdAt)}</span>
          </div>
        </div>
        <div className={styles.actions}>
          <ConnectionTest onTest={() => check.mutate({ bucketId: bucket.id })} pending={check.isPending} result={check.data} resourceName={bucket.name} />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
            disabled={!storageConfigured}
          >
            {open ? "Hide objects" : "Browse objects"}
          </button>
        </div>
      </div>

      <ConnectionResult result={check.data} error={check.error} />

      {!storageConfigured && (
        <p className={styles.muted}>Object storage is not configured on Syncbay (R2 keys missing), so objects cannot be listed.</p>
      )}

      {open && storageConfigured && (
        <div id={panelId} className={styles.panel}>
          <Breadcrumbs
            rootLabel={bucket.name}
            segments={segments}
            onNavigate={(depth) => setPrefix(depth === 0 ? "" : `${segments.slice(0, depth).join("/")}/`)}
            label={`Location in ${bucket.name}`}
          />
          {listing.isLoading && <p className={styles.muted}>Listing objects…</p>}
          {listing.error && <p className={styles.error}>{errorText(listing.error)}</p>}
          {downloadError && <p className={styles.error} role="alert">{downloadError}</p>}
          {listing.data && folders.length === 0 && objects.length === 0 && (
            <p className={styles.muted}>{prefix ? "This folder is empty." : "This bucket is empty."}</p>
          )}
          {(folders.length > 0 || objects.length > 0) && (
            <div className={`table-wrapper ${styles.tableScroll}`}>
              <table>
                <caption className={styles.srOnly}>Objects in {bucket.name}/{prefix}</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Size</th>
                    <th scope="col">Last modified</th>
                    <th scope="col">
                      <span className={styles.srOnly}>Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {folders.map((p) => {
                    const name = p.slice(prefix.length);
                    return (
                      <tr key={`p:${p}`}>
                        <td>
                          <button type="button" className={styles.entryButton} onClick={() => setPrefix(p)} aria-label={`Open folder ${name}`}>
                            <span aria-hidden="true">📁</span> {name}
                          </button>
                        </td>
                        <td>—</td>
                        <td>—</td>
                        <td />
                      </tr>
                    );
                  })}
                  {objects.map((o) => {
                    const name = o.key.slice(prefix.length);
                    return (
                      <tr key={`o:${o.key}`}>
                        <td className={styles.nameCell} title={o.key}>
                          <span aria-hidden="true">📄</span> {name}
                        </td>
                        <td>{formatBytes(o.size)}</td>
                        <td>{formatDate(o.lastModified)}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => download(o.key)}
                            disabled={presign.isPending}
                            aria-label={`Download ${name}`}
                          >
                            Download
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {listing.hasNextPage && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => listing.fetchNextPage()} disabled={listing.isFetchingNextPage}>
              {listing.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          )}
          <p className={styles.subtle}>Downloads use a presigned link that expires after 5 minutes. Listing is read-only.</p>
        </div>
      )}
    </section>
  );
}

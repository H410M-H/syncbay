"use client";

import Link from "next/link";
import { use, useState, type KeyboardEvent } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/root";
import { trpc } from "@/lib/trpc-client";
import { BackButton } from "@/components/ui/back-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ToastStack, useToasts } from "@/components/ui/toast";
import { ReasonDialog } from "@/components/admin/reason-dialog";
import { QueryState } from "@/components/admin/query-state";
import { useStaff } from "@/components/admin/staff-context";
import { useActionDialog } from "@/components/admin/use-action-dialog";
import { deploymentBadgeClass, dollars, formatDate, formatDateTime, humanize, reportStatusBadgeClass } from "@/components/admin/format";
import { LIFECYCLE_STAGES, type LifecycleStage, type NoteRow } from "@/components/admin/types";
import styles from "@/components/admin/admin.module.css";

type Workspace = inferRouterOutputs<AppRouter>["admin"]["workspace"];
type Service = Workspace["projects"][number]["environments"][number]["services"][number];

type ActionTarget =
  | { kind: "suspend" }
  | { kind: "unsuspend" }
  | { kind: "takedown"; serviceId: string; serviceName: string }
  | { kind: "restore"; serviceId: string; serviceName: string };

const MAX_TAGS = 20;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default function AdminWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const staff = useStaff();
  const utils = trpc.useUtils();
  const query = trpc.admin.workspace.useQuery({ id });
  const { toasts, push, dismiss } = useToasts();
  const dialog = useActionDialog<ActionTarget>();

  const suspend = trpc.admin.suspendWorkspace.useMutation();
  const unsuspend = trpc.admin.unsuspendWorkspace.useMutation();
  const takedown = trpc.admin.takedownService.useMutation();
  const restore = trpc.admin.restoreService.useMutation();

  const refresh = () => utils.admin.workspace.invalidate({ id });
  const w = query.data;

  const onConfirm = ({ reason, confirm }: { reason: string; confirm: string }) => {
    const target = dialog.target;
    if (!target || !w) return;
    void dialog.run(async () => {
      if (target.kind === "suspend") {
        const res = await suspend.mutateAsync({ workspaceId: w.id, reason, confirm });
        push(res.failed.length ? "error" : "success", `Suspended ${w.slug} · stopped ${plural(res.stopped.length, "service")}${res.failed.length ? ` · ${res.failed.length} could not be stopped (marked paused)` : ""}`);
      } else if (target.kind === "unsuspend") {
        await unsuspend.mutateAsync({ workspaceId: w.id, reason });
        push("success", `Lifted the suspension of ${w.slug}. The owner resumes their services.`);
      } else if (target.kind === "takedown") {
        const res = await takedown.mutateAsync({ serviceId: target.serviceId, reason, confirm });
        push(res.failed.length ? "error" : "success", `Took down ${target.serviceName}${res.failed.length ? " · the instance could not be stopped (marked paused)" : ""}`);
      } else {
        await restore.mutateAsync({ serviceId: target.serviceId, reason });
        push("success", `Restored ${target.serviceName}. The owner can start it again.`);
      }
      await refresh();
    });
  };

  const dialogProps = (() => {
    const t = dialog.target;
    if (!t || !w) return null;
    switch (t.kind) {
      case "suspend":
        return {
          title: `Suspend workspace ${w.slug}?`,
          description: "Every service is stopped and paused, and nothing in this workspace can deploy or wake until the suspension is lifted.",
          confirmLabel: "Suspend workspace",
          danger: true,
          requireText: w.slug,
        };
      case "unsuspend":
        return { title: `Lift the suspension of ${w.slug}?`, description: "Nothing is restarted; the owner resumes their services.", confirmLabel: "Unsuspend", danger: false };
      case "takedown":
        return {
          title: `Take down ${t.serviceName}?`,
          description: "The service is stopped and locked: it cannot deploy, resume or wake until staff restore it.",
          confirmLabel: "Take down",
          danger: true,
          requireText: t.serviceName,
        };
      case "restore":
        return { title: `Restore ${t.serviceName}?`, description: "Removes the moderation lock. Nothing is started.", confirmLabel: "Restore", danger: false };
    }
  })();

  return (
    <div className="fade-in">
      <BackButton fallbackUrl="/admin/workspaces" label="Workspaces" />

      <QueryState isLoading={query.isLoading} error={query.error} label="the workspace" />

      {w && (
        <>
          <div className="page-header" style={{ marginBottom: "20px" }}>
            <div style={{ minWidth: 0 }}>
              <h1 className="page-title" style={{ wordBreak: "break-word" }}>
                {w.name}
              </h1>
              <p className="page-subtitle">
                <span className={styles.mono}>{w.slug}</span> · created {formatDate(w.createdAt)}
                {w.isPersonal ? " · personal" : ""} · <span className={styles.mono}>{w.id}</span>
              </p>
              <div className={styles.row} style={{ marginTop: "10px" }}>
                {w.suspendedAt ? <span className="badge badge-failed">Suspended {formatDate(w.suspendedAt)}</span> : <span className="badge badge-active">Active</span>}
                {w.lifecycleStage && <span className="badge badge-queued">Lifecycle: {humanize(w.lifecycleStage)}</span>}
              </div>
              {w.suspendedAt && w.suspendedReason && <p className={styles.secondary} style={{ marginTop: "8px" }}>Reason: {w.suspendedReason}</p>}
            </div>
            <div className={styles.actions}>
              {!w.suspendedAt && staff.can("workspace.suspend") && (
                <button type="button" className="btn btn-danger" onClick={() => dialog.open({ kind: "suspend" })}>
                  Suspend workspace
                </button>
              )}
              {w.suspendedAt && staff.can("workspace.unsuspend") && (
                <button type="button" className="btn btn-secondary" onClick={() => dialog.open({ kind: "unsuspend" })}>
                  Unsuspend
                </button>
              )}
            </div>
          </div>

          <CrmEditor
            key={`${w.lifecycleStage ?? ""}|${w.staffTags.join(",")}`}
            workspaceId={w.id}
            lifecycleStage={w.lifecycleStage}
            tags={w.staffTags}
            editable={staff.can("workspace.tags.write")}
            onSaved={async () => {
              push("success", "Saved lifecycle stage and tags");
              await refresh();
            }}
            onError={(m) => push("error", m)}
          />

          <section className={`card ${styles.section}`} aria-labelledby="members-title">
            <h2 id="members-title" className={styles.sectionTitle}>
              Members ({w.members.length})
            </h2>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Email</th>
                    <th scope="col">Name</th>
                    <th scope="col">Role</th>
                    <th scope="col">Joined</th>
                    <th scope="col">Account</th>
                  </tr>
                </thead>
                <tbody>
                  {w.members.map((m) => (
                    <tr key={m.user.id}>
                      <td>
                        <Link href={`/admin/users?q=${encodeURIComponent(m.user.email)}`}>{m.user.email}</Link>
                      </td>
                      <td className={styles.secondary}>{m.user.name ?? "—"}</td>
                      <td>{humanize(m.role)}</td>
                      <td className={`${styles.secondary} ${styles.cellNowrap}`}>{formatDate(m.joinedAt)}</td>
                      <td>{m.user.suspendedAt ? <span className="badge badge-failed">Suspended</span> : <span className={styles.muted}>OK</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.section} aria-labelledby="projects-title">
            <h2 id="projects-title" className={styles.sectionTitle}>
              Projects and services ({w.projects.length})
            </h2>
            {w.projects.length === 0 && <div className={`card ${styles.empty}`}>No projects.</div>}
            {w.projects.map((p) => (
              <div key={p.id} className="card" style={{ marginBottom: "12px" }}>
                <h3 style={{ fontSize: "0.95rem", margin: "0 0 8px" }}>{p.name}</h3>
                {p.environments.map((env) => (
                  <div key={env.name} style={{ marginBottom: "8px" }}>
                    <div className={styles.muted} style={{ textTransform: "uppercase", letterSpacing: "0.06em", fontSize: "0.7rem" }}>
                      {env.name}
                    </div>
                    {env.services.length === 0 ? (
                      <p className={styles.muted}>No services.</p>
                    ) : (
                      <ul className={styles.list}>
                        {env.services.map((s) => (
                          <ServiceItem
                            key={s.id}
                            service={s}
                            canTakedown={staff.can("service.takedown")}
                            canRestore={staff.can("service.restore")}
                            onTakedown={() => dialog.open({ kind: "takedown", serviceId: s.id, serviceName: s.name })}
                            onRestore={() => dialog.open({ kind: "restore", serviceId: s.id, serviceName: s.name })}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </section>

          <DatabasesSection workspace={w} />

          {w.billing && <BillingSection billing={w.billing} />}
          {w.usage && <UsageSection usage={w.usage} />}

          <section className={`card ${styles.section}`} aria-labelledby="reports-title">
            <h2 id="reports-title" className={styles.sectionTitle}>
              Abuse reports ({w.reports.length})
            </h2>
            {w.reports.length === 0 ? (
              <p className={styles.muted}>No reports against this workspace.</p>
            ) : (
              <ul className={styles.list}>
                {w.reports.map((r) => (
                  <li key={r.id} className={styles.listItem}>
                    <span className={styles.row}>
                      <span className="badge badge-queued">{humanize(r.category)}</span>
                      <span className={reportStatusBadgeClass(r.status)}>{humanize(r.status)}</span>
                      <span className={styles.mono}>{r.targetHost ?? "—"}</span>
                    </span>
                    <span className={styles.row}>
                      <span className={styles.muted}>{formatDateTime(r.createdAt)}</span>
                      <Link href={`/admin/moderation?status=${r.status}`} className={styles.secondary}>
                        Open queue
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={`card ${styles.section}`} aria-labelledby="audit-title">
            <h2 id="audit-title" className={styles.sectionTitle}>
              Customer audit log
            </h2>
            {w.audit.length === 0 ? (
              <p className={styles.muted}>No audit entries.</p>
            ) : (
              <ul className={styles.list}>
                {w.audit.map((a) => (
                  <li key={a.id} className={styles.listItem}>
                    <span>
                      <span className={styles.mono}>{a.action}</span>
                      <span className={styles.muted}> · {a.actor?.email ?? "Syncbay / system"}</span>
                    </span>
                    <span className={styles.muted}>{formatDateTime(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <NotesSection
            workspaceId={w.id}
            notes={w.notes as NoteRow[]}
            canWrite={staff.can("workspace.note.write")}
            canDelete={(n) => n.authorId === staff.userId || staff.role === "ADMIN" || staff.role === "SUPER_ADMIN"}
            onChanged={refresh}
            push={push}
          />
        </>
      )}

      {dialogProps && (
        <ReasonDialog
          open={dialog.target !== null}
          {...dialogProps}
          busy={dialog.busy}
          error={dialog.error}
          onConfirm={onConfirm}
          onCancel={dialog.close}
        />
      )}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function ServiceItem({
  service: s,
  canTakedown,
  canRestore,
  onTakedown,
  onRestore,
}: {
  service: Service;
  canTakedown: boolean;
  canRestore: boolean;
  onTakedown: () => void;
  onRestore: () => void;
}) {
  const latest = s.deployments[0];
  return (
    <li className={styles.listItem}>
      <div style={{ minWidth: 0, flex: "1 1 360px", display: "flex", flexDirection: "column", gap: "6px" }}>
        <div className={styles.row}>
          <strong>{s.name}</strong>
          <span className={deploymentBadgeClass(latest?.status)}>{latest ? humanize(latest.status) : "Not deployed"}</span>
          {s.isPaused && <span className="badge badge-sleeping">Paused</span>}
          {s.scaleToZero && <span className={styles.chip}>scale to zero</span>}
          {s.moderationLockedAt && <span className="badge badge-failed">Taken down {formatDate(s.moderationLockedAt)}</span>}
        </div>
        {s.moderationLockedAt && s.moderationReason && <div className={styles.secondary}>Moderation reason: {s.moderationReason}</div>}
        {s.repoUrl && <div className={`${styles.mono} ${styles.muted}`}>{s.repoUrl}</div>}
        {latest?.errorMessage && <div className={`${styles.mono} ${styles.muted}`}>Last error: {latest.errorMessage.slice(0, 300)}</div>}
        <div className={styles.row}>
          <span className={styles.muted}>Domains:</span>
          {s.domains.length ? (
            <span className={styles.chips}>
              {s.domains.map((d) => (
                <span key={d.hostname} className={styles.chip}>
                  {d.hostname} <span className={styles.muted}>({humanize(d.status)})</span>
                </span>
              ))}
            </span>
          ) : (
            <span className={styles.muted}>none</span>
          )}
        </div>
        <div className={styles.row}>
          <span className={styles.muted}>Variables (names only):</span>
          {s.variables.length ? (
            <span className={styles.chips}>
              {s.variables.map((v) => (
                <code key={v.key} className={styles.chip}>
                  {v.key}
                </code>
              ))}
            </span>
          ) : (
            <span className={styles.muted}>none</span>
          )}
        </div>
      </div>
      <div className={styles.actions}>
        {!s.moderationLockedAt && canTakedown && (
          <button type="button" className="btn btn-danger btn-sm" onClick={onTakedown} aria-label={`Take down service ${s.name}`}>
            Take down
          </button>
        )}
        {s.moderationLockedAt && canRestore && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRestore} aria-label={`Restore service ${s.name}`}>
            Restore
          </button>
        )}
      </div>
    </li>
  );
}

function CrmEditor({
  workspaceId,
  lifecycleStage,
  tags: initialTags,
  editable,
  onSaved,
  onError,
}: {
  workspaceId: string;
  lifecycleStage: string | null;
  tags: string[];
  editable: boolean;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [stage, setStage] = useState(lifecycleStage ?? "");
  const [tags, setTags] = useState(initialTags);
  const [draft, setDraft] = useState("");
  const save = trpc.admin.setWorkspaceCrm.useMutation();
  const dirty = stage !== (lifecycleStage ?? "") || tags.join(",") !== initialTags.join(",");

  const addTag = () => {
    const t = draft.trim().toLowerCase().slice(0, 32);
    if (!t) return;
    if (!tags.includes(t) && tags.length < MAX_TAGS) setTags([...tags, t]);
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag();
    }
  };

  const onSave = async () => {
    try {
      await save.mutateAsync({
        workspaceId,
        lifecycleStage: stage ? (stage as LifecycleStage) : null,
        tags,
      });
      await onSaved();
    } catch (err) {
      onError((err as Error)?.message || "Could not save");
    }
  };

  return (
    <section className={`card ${styles.section}`} aria-labelledby="crm-title">
      <h2 id="crm-title" className={styles.sectionTitle}>
        Lifecycle and tags
      </h2>
      <div className={styles.toolbar} style={{ marginBottom: 0 }}>
        <div className="field">
          <label htmlFor="crm-stage">Lifecycle stage</label>
          <select id="crm-stage" className="input" value={stage} onChange={(e) => setStage(e.target.value)} disabled={!editable || save.isPending}>
            <option value="">Not set</option>
            {LIFECYCLE_STAGES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        </div>
        <div className={`field ${styles.grow}`}>
          <label htmlFor="crm-tag">Tags</label>
          <div className={styles.chips} style={{ marginBottom: tags.length ? "6px" : 0 }}>
            {tags.map((t) => (
              <span key={t} className={styles.chip}>
                {t}
                {editable && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ padding: "0 4px", minHeight: 0 }}
                    aria-label={`Remove tag ${t}`}
                    onClick={() => setTags(tags.filter((x) => x !== t))}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {!editable && tags.length === 0 && <span className={styles.muted}>No tags</span>}
          </div>
          {editable && (
            <div className={styles.row}>
              <input
                id="crm-tag"
                className="input"
                style={{ flex: "1 1 160px", width: "auto" }}
                value={draft}
                maxLength={32}
                placeholder={tags.length >= MAX_TAGS ? `At most ${MAX_TAGS} tags` : "Add a tag and press Enter"}
                disabled={tags.length >= MAX_TAGS || save.isPending}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
              />
              <button type="button" className="btn btn-secondary btn-sm" onClick={addTag} disabled={!draft.trim() || tags.length >= MAX_TAGS}>
                Add tag
              </button>
            </div>
          )}
        </div>
        {editable && (
          <button type="button" className="btn btn-primary" onClick={() => void onSave()} disabled={!dirty || save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        )}
      </div>
    </section>
  );
}

function DatabasesSection({ workspace }: { workspace: Workspace }) {
  const rows = workspace.projects.flatMap((p) => p.environments.flatMap((e) => e.databases.map((d) => ({ ...d, project: p.name, environment: e.name }))));
  return (
    <section className={`card ${styles.section}`} aria-labelledby="dbs-title">
      <h2 id="dbs-title" className={styles.sectionTitle}>
        Databases ({rows.length})
      </h2>
      {rows.length === 0 ? (
        <p className={styles.muted}>No databases.</p>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Provider</th>
                <th scope="col">Status</th>
                <th scope="col">Project / environment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>{d.name}</td>
                  <td>{d.provider}</td>
                  <td>
                    <span className={d.status === "ACTIVE" ? "badge badge-active" : d.status === "FAILED" || d.status === "UNHEALTHY" ? "badge badge-failed" : "badge badge-building"}>
                      {humanize(d.status)}
                    </span>
                  </td>
                  <td className={styles.secondary}>
                    {d.project} / {d.environment}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BillingSection({ billing }: { billing: NonNullable<Workspace["billing"]> }) {
  return (
    <section className={`card ${styles.section}`} aria-labelledby="billing-title">
      <h2 id="billing-title" className={styles.sectionTitle}>
        Billing
      </h2>
      <div className={styles.statGrid}>
        <div>
          <div className="stat-label">Credit balance</div>
          <div style={{ fontSize: "1.25rem", fontWeight: 700 }}>{dollars(billing.creditBalanceCents)}</div>
        </div>
        <div>
          <div className="stat-label">Spending cap</div>
          <div style={{ fontSize: "1.25rem", fontWeight: 700 }}>{billing.spendingCapCents === null ? "None" : dollars(billing.spendingCapCents)}</div>
          {billing.spendCapReachedAt && <div className="stat-change" style={{ color: "#f87171" }}>Reached {formatDate(billing.spendCapReachedAt)}</div>}
        </div>
        <div>
          <div className="stat-label">Stripe customer</div>
          <div className={styles.mono}>{billing.stripeCustomerId ?? "—"}</div>
        </div>
      </div>

      <h3 style={{ fontSize: "0.875rem", margin: "0 0 8px" }}>Payment methods</h3>
      {billing.paymentMethods.length === 0 ? (
        <p className={styles.muted} style={{ marginBottom: "12px" }}>
          No saved cards.
        </p>
      ) : (
        <ul className={styles.list} style={{ marginBottom: "12px" }}>
          {billing.paymentMethods.map((pm, i) => (
            <li key={`${pm.last4}-${i}`} className={styles.listItem}>
              <span>
                {pm.brand} •••• {pm.last4}
                {pm.isDefault ? " · default" : ""}
              </span>
              <span className={styles.muted}>
                expires {String(pm.expMonth).padStart(2, "0")}/{pm.expYear}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3 style={{ fontSize: "0.875rem", margin: "0 0 8px" }}>Invoices</h3>
      {billing.invoices.length === 0 ? (
        <p className={styles.muted}>No invoices.</p>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col">Document</th>
              </tr>
            </thead>
            <tbody>
              {billing.invoices.map((inv) => (
                <tr key={inv.id}>
                  <td>{new Date(inv.periodStart).toISOString().slice(0, 7)}</td>
                  <td>{dollars(inv.amountCents)}</td>
                  <td>
                    <span className={inv.status === "PAID" ? "badge badge-active" : inv.status === "PAST_DUE" ? "badge badge-failed" : "badge badge-queued"}>{humanize(inv.status)}</span>
                  </td>
                  <td>
                    {inv.pdfUrl ? (
                      <a href={inv.pdfUrl} target="_blank" rel="noopener noreferrer">
                        View
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function UsageSection({ usage }: { usage: NonNullable<Workspace["usage"]> }) {
  const entries = Object.entries(usage.totals) as Array<[string, number]>;
  return (
    <section className={`card ${styles.section}`} aria-labelledby="usage-title">
      <h2 id="usage-title" className={styles.sectionTitle}>
        Usage since {formatDate(usage.periodStart)}
      </h2>
      <ul className={styles.list}>
        {entries.map(([resource, qty]) => (
          <li key={resource} className={styles.listItem}>
            <span className={styles.secondary}>{humanize(resource)}</span>
            <span>{Number(qty).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
          </li>
        ))}
        <li className={styles.listItem}>
          <strong>Estimated cost</strong>
          <strong>{dollars(usage.estimatedCostCents)}</strong>
        </li>
      </ul>
    </section>
  );
}

function NotesSection({
  workspaceId,
  notes,
  canWrite,
  canDelete,
  onChanged,
  push,
}: {
  workspaceId: string;
  notes: NoteRow[];
  canWrite: boolean;
  canDelete: (note: NoteRow) => boolean;
  onChanged: () => Promise<void>;
  push: (tone: "success" | "error" | "info", message: string) => void;
}) {
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const addNote = trpc.admin.addNote.useMutation();
  const updateNote = trpc.admin.updateNote.useMutation();
  const deleteDialog = useActionDialog<NoteRow>();
  const [busyNote, setBusyNote] = useState<string | null>(null);

  const onAdd = async () => {
    const text = body.trim();
    if (!text) return;
    try {
      await addNote.mutateAsync({ workspaceId, body: text, pinned });
      setBody("");
      setPinned(false);
      await onChanged();
    } catch (err) {
      push("error", (err as Error)?.message || "Could not add the note");
    }
  };

  const onTogglePin = async (note: NoteRow) => {
    setBusyNote(note.id);
    try {
      await updateNote.mutateAsync({ noteId: note.id, pinned: !note.pinned });
      await onChanged();
    } catch (err) {
      push("error", (err as Error)?.message || "Could not update the note");
    } finally {
      setBusyNote(null);
    }
  };

  return (
    <section className={`card ${styles.section}`} aria-labelledby="notes-title">
      <h2 id="notes-title" className={styles.sectionTitle}>
        Staff notes
      </h2>
      <p className={styles.muted} style={{ marginBottom: "12px" }}>
        Internal only: customers never see notes.
      </p>
      {canWrite && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onAdd();
          }}
          style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" }}
        >
          <div className="field">
            <label htmlFor="note-body">New note</label>
            <textarea
              id="note-body"
              className="input"
              rows={3}
              maxLength={5000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={addNote.isPending}
              style={{ resize: "vertical" }}
            />
          </div>
          <div className={styles.row} style={{ justifyContent: "space-between" }}>
            <label className={styles.row} style={{ fontSize: "0.8125rem", cursor: "pointer" }}>
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin to the top
            </label>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!body.trim() || addNote.isPending}>
              {addNote.isPending ? "Adding…" : "Add note"}
            </button>
          </div>
        </form>
      )}
      {notes.length === 0 ? (
        <p className={styles.muted}>No notes yet.</p>
      ) : (
        <ul className={styles.list}>
          {notes.map((n) => (
            <li key={n.id} className={styles.listItem}>
              <div style={{ minWidth: 0, flex: "1 1 320px" }}>
                <div className={styles.row} style={{ marginBottom: "4px" }}>
                  {n.pinned && <span className="badge badge-building">Pinned</span>}
                  <span className={styles.muted}>
                    {n.author?.email ?? "former staff"} · {formatDateTime(n.createdAt)}
                  </span>
                </div>
                <div className={styles.preWrap}>{n.body}</div>
              </div>
              {canWrite && (
                <div className={styles.actions}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void onTogglePin(n)} disabled={busyNote === n.id}>
                    {n.pinned ? "Unpin" : "Pin"}
                  </button>
                  {canDelete(n) && (
                    <button type="button" className="btn btn-ghost btn-sm" style={{ color: "#f87171" }} onClick={() => deleteDialog.open(n)}>
                      Delete
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={deleteDialog.target !== null}
        danger
        title="Delete this note?"
        description="The note is hidden from the workspace. The deletion is recorded in the staff audit log."
        confirmLabel="Delete note"
        busy={deleteDialog.busy}
        error={deleteDialog.error}
        onCancel={deleteDialog.close}
        onConfirm={() => {
          const note = deleteDialog.target;
          if (!note) return;
          void deleteDialog.run(async () => {
            await updateNote.mutateAsync({ noteId: note.id, delete: true });
            push("success", "Note deleted");
            await onChanged();
          });
        }}
      />
    </section>
  );
}

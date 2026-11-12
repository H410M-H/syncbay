"use client";

/**
 * Staff action dialog: a written reason (audited; the API requires at least 8 characters) and,
 * for "confirm"-gated actions, typing the target's name (workspace slug, service name, email).
 * Built on the native `<dialog>` like `ConfirmDialog`, whose styles it reuses. `onConfirm` may be
 * async: the dialog shows `busy` and stays open with `error` until the caller closes it.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import styles from "@/components/ui/confirm-dialog.module.css";

export const MIN_REASON_LENGTH = 8;

interface ReasonDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** When set, the confirm button stays disabled until this text is typed (case-insensitive, like the API). */
  requireText?: string;
  /** Ask for a reason (default true). */
  requireReason?: boolean;
  reasonLabel?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (values: { reason: string; confirm: string }) => void | Promise<void>;
  onCancel: () => void;
}

export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  danger = false,
  requireText,
  requireReason = true,
  reasonLabel = "Reason (recorded in the staff audit log)",
  busy = false,
  error,
  onConfirm,
  onCancel,
}: ReasonDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [wasOpen, setWasOpen] = useState(open);
  const titleId = useId();
  const descId = useId();
  const reasonId = useId();
  const reasonHintId = useId();
  const confirmId = useId();

  // Every opening starts empty (state adjusted during render).
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setReason("");
      setConfirm("");
    }
  }

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const reasonOk = !requireReason || reason.trim().length >= MIN_REASON_LENGTH;
  const confirmOk = requireText === undefined || confirm.trim().toLowerCase() === requireText.trim().toLowerCase();
  const canConfirm = !busy && reasonOk && confirmOk;

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !busy) onCancel();
      }}
    >
      <form
        method="dialog"
        className={styles.body}
        onSubmit={(e) => {
          e.preventDefault();
          if (canConfirm) void onConfirm({ reason: reason.trim(), confirm: confirm.trim() });
        }}
      >
        <h2 id={titleId} className={styles.title} style={danger ? { color: "#f87171" } : undefined}>
          {title}
        </h2>
        {description && (
          <div id={descId} className={styles.description}>
            {description}
          </div>
        )}
        {requireReason && (
          <div className="field">
            <label htmlFor={reasonId}>{reasonLabel}</label>
            <textarea
              id={reasonId}
              className="input"
              rows={3}
              autoFocus
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
              aria-describedby={reasonHintId}
              style={{ resize: "vertical", minHeight: "72px" }}
            />
            <span id={reasonHintId} className="field-hint">
              At least {MIN_REASON_LENGTH} characters{reason.trim().length > 0 && !reasonOk ? ` (${reason.trim().length} so far)` : ""}.
            </span>
          </div>
        )}
        {requireText !== undefined && (
          <div className="field">
            <label htmlFor={confirmId}>
              Type <code>{requireText}</code> to confirm
            </label>
            <input
              id={confirmId}
              className="input"
              autoComplete="off"
              spellCheck={false}
              autoFocus={!requireReason}
              value={confirm}
              placeholder={requireText}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
            />
          </div>
        )}
        {error && (
          <div role="alert" className={styles.error}>
            {error}
          </div>
        )}
        <div className={styles.actions}>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={danger ? "btn btn-danger" : "btn btn-primary"} disabled={!canConfirm}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

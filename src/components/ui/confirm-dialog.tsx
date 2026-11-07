"use client";

/**
 * Modal confirmation built on the native `<dialog>` (focus is trapped, Escape cancels, focus
 * returns to the opener). `requireText` makes the user type a value (e.g. the project name)
 * before the confirm button enables; `input` turns it into a one-field prompt (e.g. rename),
 * whose value is passed to `onConfirm`. `onConfirm` may be async: the dialog shows `busy`
 * and stays open with `error` until the caller closes it.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import styles from "./confirm-dialog.module.css";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** The confirm button stays disabled until this exact text is typed. */
  requireText?: string;
  /** Collect a value instead (rename): label, initial value and constraints. */
  input?: { label: string; initialValue?: string; placeholder?: string; maxLength?: number };
  busy?: boolean;
  error?: string | null;
  onConfirm: (value: string) => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  requireText,
  input,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(input?.initialValue ?? "");
  const [wasOpen, setWasOpen] = useState(open);
  const titleId = useId();
  const descId = useId();
  const fieldId = useId();

  // Each time the dialog opens it starts from the initial value (state adjusted during render).
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setValue(input?.initialValue ?? "");
  }

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const trimmed = value.trim();
  const canConfirm =
    !busy && (requireText !== undefined ? value === requireText : input ? trimmed.length > 0 : true);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault(); // the parent owns `open`
        if (!busy) onCancel();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !busy) onCancel(); // backdrop click
      }}
    >
      <form
        method="dialog"
        className={styles.body}
        onSubmit={(e) => {
          e.preventDefault();
          if (canConfirm) void onConfirm(input ? trimmed : value);
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
        {(requireText !== undefined || input) && (
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={fieldId} style={{ display: "block", marginBottom: "6px", fontSize: "0.8125rem" }}>
              {input ? input.label : (
                <>
                  Type <code>{requireText}</code> to confirm
                </>
              )}
            </label>
            <input
              id={fieldId}
              className="input"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={value}
              maxLength={input?.maxLength}
              placeholder={input?.placeholder ?? requireText}
              onChange={(e) => setValue(e.target.value)}
              disabled={busy}
              style={{ width: "100%" }}
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
            {cancelLabel}
          </button>
          <button type="submit" className={danger ? "btn btn-danger" : "btn btn-primary"} disabled={!canConfirm}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

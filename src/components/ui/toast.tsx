"use client";

/**
 * Minimal toast stack: `useToasts()` returns `{ toasts, push, dismiss }`; render `<ToastStack>`
 * once. Toasts are announced politely (errors assertively) and dismiss themselves after 6 s
 * (errors after 10 s).
 */

import { useCallback, useEffect, useRef, useState } from "react";

type ToastTone = "success" | "error" | "info";

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { id, tone, message }]);
      timers.current.set(id, setTimeout(() => dismiss(id), tone === "error" ? 10_000 : 6_000));
    },
    [dismiss]
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  return { toasts, push, dismiss };
}

const TONES: Record<ToastTone, { border: string; color: string; icon: string }> = {
  success: { border: "rgba(34,197,94,0.45)", color: "#4ade80", icon: "✔" },
  error: { border: "rgba(239,68,68,0.5)", color: "#fca5a5", icon: "⚠" },
  info: { border: "rgba(6,182,212,0.45)", color: "#38bdf8", icon: "ℹ" },
};

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div
      style={{
        position: "fixed",
        right: "20px",
        bottom: "20px",
        zIndex: 1100,
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        maxWidth: "min(420px, calc(100vw - 40px))",
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          aria-live={t.tone === "error" ? "assertive" : "polite"}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "10px",
            padding: "12px 14px",
            borderRadius: "var(--radius-md)",
            border: `1px solid ${TONES[t.tone].border}`,
            background: "var(--bg-elevated)",
            boxShadow: "var(--shadow-lg)",
            color: TONES[t.tone].color,
            fontSize: "0.875rem",
            lineHeight: 1.45,
          }}
        >
          <span aria-hidden="true">{TONES[t.tone].icon}</span>
          <span style={{ flex: 1, color: "var(--text-primary)" }}>{t.message}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(t.id)}
            style={{ padding: "0 6px" }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
